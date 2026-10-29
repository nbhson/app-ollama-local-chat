"""HTTP request handler for the Ollama Chat web UI."""

import json
import mimetypes
import os
import socket
from http.server import BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs

from .config import (DEFAULT_OLLAMA_URL, DEFAULT_MODEL, DEFAULT_TEMPERATURE,
                     DEFAULT_SYSTEM_PROMPT, STATIC_DIR, validate_ollama_url)
from .ollama import fetch_models, fetch_model_info, stream_chat

# Chặn DoS: client gửi Content-Length khổng lồ sẽ làm server đọc vô hạn vào RAM.
MAX_BODY_BYTES = 25 * 1024 * 1024


class BodyTooLarge(ValueError):
    """Sentinel riêng: phân biệt body vượt giới hạn (413) với JSON hỏng (400)."""


class ChunkedBodyNotSupported(Exception):
    """Transfer-Encoding: chunked không decode được trên stdlib handler (411)."""


class ChatHandler(BaseHTTPRequestHandler):
    server_version = "OllamaChat/1.1"

    def log_request(self, code='-', size='-'):
        # Chỉ ghi log request lỗi (>= 500). Log mọi request sẽ spam stdout khi
        # stream chat; im lặng hoàn toàn thì mất khả năng debug lỗi 5xx.
        try:
            status = int(code)
        except (ValueError, TypeError):
            status = 0
        if status >= 500:
            super().log_request(code, size)

    # --- Response helpers ---

    def _security_headers(self):
        # Hardening: tránh MIME-sniffing, clickjacking, leak referrer.
        # CSP: script/style chỉ 'self' — toàn bộ JS/CSS (marked, DOMPurify,
        # highlight.js) đã được vendor vào static/vendor/. img cho phép data:
        # (preview ảnh attach) và blob: (audio); không có origin ngoài.
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Content-Security-Policy",
                         "default-src 'self'; "
                         "script-src 'self'; "
                         "style-src 'self' 'unsafe-inline'; "
                         "img-src 'self' data: blob:; "
                         "media-src 'self' blob:; "
                         "connect-src 'self'; "
                         "frame-ancestors 'none'")

    def _send_json(self, status, obj, include_body=True):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self._security_headers()
        self.end_headers()
        if include_body:
            self.wfile.write(body)

    def _send_error(self, status, msg, include_body=True):
        self._send_json(status, {"error": msg}, include_body=include_body)

    def _read_body(self):
        if (self.headers.get("Transfer-Encoding", "") or "").strip().lower() == "chunked":
            # stdlib handler không decode chunked — nếu đọc theo Content-Length
            # (thiếu) thì body sót lại làm hỏng request kế trên keep-alive.
            # 411 Length Required đúng ngữ nghĩa hơn 413 ở đây.
            raise ChunkedBodyNotSupported()
        try:
            length = int(self.headers.get("Content-Length", 0))
        except ValueError:
            length = 0
        if length <= 0:
            return b""
        if length > MAX_BODY_BYTES:
            raise BodyTooLarge("body too large")
        return self.rfile.read(length)

    def _serve_static(self, filename, include_body=True):
        safe = os.path.normpath(filename)
        if safe.startswith("..") or os.path.isabs(safe):
            self._send_error(403, "Forbidden", include_body=include_body)
            return
        filepath = os.path.join(STATIC_DIR, safe)
        # Chốt bằng realpath: symlink/escape trick (vd "sub/../../etc/passwd")
        # qua được normpath nhưng không được rời khỏi STATIC_DIR.
        if not os.path.realpath(filepath).startswith(os.path.realpath(STATIC_DIR) + os.sep):
            self._send_error(403, "Forbidden", include_body=include_body)
            return
        if not os.path.isfile(filepath):
            self._send_error(404, "Not found", include_body=include_body)
            return
        ctype, _ = mimetypes.guess_type(filepath)
        with open(filepath, "rb") as f:
            body = f.read()
        self.send_response(200)
        self.send_header("Content-Type", ctype or "application/octet-stream")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-cache")
        self._security_headers()
        self.end_headers()
        if include_body:
            self.wfile.write(body)

    # --- Handlers ---

    def _handle_get(self, include_body=True):
        parsed = urlparse(self.path)
        path = parsed.path
        if path in ("/", "/index.html"):
            self._serve_static("index.html", include_body=include_body)
        elif path == "/api/models":
            query = parse_qs(parsed.query)
            url, err = validate_ollama_url(query.get("url", [DEFAULT_OLLAMA_URL])[0])
            if err:
                self._send_json(400, {"error": err}, include_body=include_body)
                return
            models, fetch_err = fetch_models(url)
            resp = {"models": models, "default": DEFAULT_MODEL}
            if fetch_err:
                resp["error"] = fetch_err
            self._send_json(200, resp, include_body=include_body)
        elif path.startswith("/static/"):
            self._serve_static(path[len("/static/"):], include_body=include_body)
        else:
            self._send_error(404, "Not found", include_body=include_body)

    def do_GET(self):
        self._handle_get(include_body=True)

    def do_HEAD(self):
        # HEAD / trả header không body (health check, proxy).
        self._handle_get(include_body=False)

    def do_POST(self):
        parsed = urlparse(self.path)
        if parsed.path == "/api/model-info":
            self._handle_model_info()
            return
        if parsed.path != "/api/chat":
            self._send_error(404, "Not found")
            return
        self._handle_chat()

    # --- API: /api/chat ---

    @staticmethod
    def _validate_messages(messages):
        """Return error string or None. Mỗi message phải có role/content string."""
        if not isinstance(messages, list) or not messages:
            return "No messages provided"
        for m in messages:
            if (not isinstance(m, dict)
                    or not isinstance(m.get("role"), str)
                    or not isinstance(m.get("content"), str)):
                return "Each message must have string 'role' and 'content'"
        return None

    def _handle_chat(self):
        body = self._read_json_or_respond()
        if body is None:
            return
        if not isinstance(body, dict):
            self._send_error(400, "Body must be a JSON object")
            return
        # Validate messages TRƯỚC khi đụng tới URL (fail fast trên input sai)
        messages = body.get("messages", [])
        err = self._validate_messages(messages)
        if err:
            self._send_error(400, err)
            return

        ollama_url, err = validate_ollama_url(body.get("ollama_url") or DEFAULT_OLLAMA_URL)
        if err:
            self._send_error(400, err)
            return
        model = body.get("model", DEFAULT_MODEL)
        if not isinstance(model, str) or not model.strip():
            self._send_error(400, "Invalid model")
            return
        temperature = body.get("temperature", DEFAULT_TEMPERATURE)
        if not isinstance(temperature, (int, float)) or isinstance(temperature, bool) \
                or not (0 <= float(temperature) <= 2):
            self._send_error(400, "temperature must be a number between 0 and 2")
            return
        system_prompt = body.get("system_prompt", DEFAULT_SYSTEM_PROMPT)
        if system_prompt is not None and not isinstance(system_prompt, str):
            self._send_error(400, "Invalid system_prompt")
            return

        if system_prompt and messages[0].get("role") != "system":
            messages = [{"role": "system", "content": system_prompt}] + messages

        payload = {"model": model, "messages": messages, "stream": True,
                   "options": {"temperature": float(temperature)}}

        self.send_response(200)
        self.send_header("Content-Type", "application/x-ndjson; charset=utf-8")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("X-Accel-Buffering", "no")
        self._security_headers()
        self.end_headers()

        def on_chunk(text):
            # Client ngắt kết nối → raise để stream_chat ngừng đọc upstream
            # luôn thay vì tiếp tục pull hết token từ Ollama vô ích.
            # socket.timeout: client nhận quá chậm / half-open connection —
            # cũng phải coi là ngắt, nếu không thread treo đến 600s.
            try:
                self.wfile.write(text.encode("utf-8"))
                self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError, TimeoutError, socket.timeout) as e:
                raise ConnectionError("client disconnected") from e

        try:
            status, error = stream_chat(ollama_url, payload, on_chunk)
        except ConnectionError:
            return  # client đã ngắt — không còn gì để gửi
        if error:
            # Lỗi được gửi như một NDJSON frame có cấu trúc — client parse được
            # mà không phải đoán bằng substring "[ERROR]" trong nội dung model
            # (model hoàn toàn có thể sinh ra đúng chuỗi đó).
            try:
                self.wfile.write((json.dumps({"t": "error", "d": str(error)}) + "\n").encode("utf-8"))
                self.wfile.flush()
            except Exception:
                pass

    # --- API: /api/model-info ---

    def _handle_model_info(self):
        body = self._read_json_or_respond()
        if body is None:
            return
        if not isinstance(body, dict):
            self._send_error(400, "Body must be a JSON object")
            return
        ollama_url, err = validate_ollama_url(body.get("ollama_url", DEFAULT_OLLAMA_URL))
        if err:
            self._send_error(400, err)
            return
        model = body.get("model", "")
        if not isinstance(model, str) or not model.strip():
            self._send_error(400, "No model provided")
            return
        # fetch_model_info trả về (info, error, upstream_status): phân biệt
        # "không kết nối được" (502) với "model không tồn tại" (404).
        info, fetch_err, upstream_status = fetch_model_info(ollama_url, model)
        if fetch_err:
            self._send_error(404 if upstream_status == 404 else 502, fetch_err)
            return
        self._send_json(200, info)

    # --- Utility ---

    def _read_json_or_respond(self):
        """Đọc JSON body; tự trả 411/413/400 khi lỗi. Trả None nếu đã respond."""
        try:
            return self._read_json()
        except BodyTooLarge:
            self._send_error(413, "Request body too large")
        except ChunkedBodyNotSupported:
            self._send_error(411, "Chunked request bodies are not supported")
        return None

    def _read_json(self):
        try:
            return json.loads(self._read_body().decode("utf-8"))
        except (BodyTooLarge, ChunkedBodyNotSupported):
            # Re-raise để caller (_read_json_or_respond) map đúng status
            raise
        except (ValueError, UnicodeDecodeError):
            self._send_error(400, "Invalid JSON body")
            return None
