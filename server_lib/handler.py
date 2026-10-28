"""HTTP request handler for the Ollama Chat web UI."""

import json
import mimetypes
import os
from http.server import BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs

from .config import (DEFAULT_OLLAMA_URL, DEFAULT_MODEL, DEFAULT_TEMPERATURE,
                     DEFAULT_SYSTEM_PROMPT, STATIC_DIR, validate_ollama_url)
from .ollama import fetch_models, fetch_model_info, stream_chat

# Chặn DoS: client gửi Content-Length khổng lồ sẽ làm server đọc vô hạn vào RAM.
MAX_BODY_BYTES = 25 * 1024 * 1024


class BodyTooLarge(ValueError):
    """Sentinel riêng: phân biệt body vượt giới hạn (413) với JSON hỏng (400)."""


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
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Referrer-Policy", "no-referrer")

    def _send_json(self, status, obj):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self._security_headers()
        self.end_headers()
        self.wfile.write(body)

    def _send_error(self, status, msg):
        self._send_json(status, {"error": msg})

    def _read_body(self):
        if (self.headers.get("Transfer-Encoding", "") or "").strip().lower() == "chunked":
            # stdlib handler không decode chunked — nếu đọc theo Content-Length
            # (thiếu) thì body sót lại làm hỏng request kế trên keep-alive.
            raise BodyTooLarge("chunked body not supported")
        try:
            length = int(self.headers.get("Content-Length", 0))
        except ValueError:
            length = 0
        if length <= 0:
            return b""
        if length > MAX_BODY_BYTES:
            raise BodyTooLarge("body too large")
        return self.rfile.read(length)

    def _serve_static(self, filename):
        safe = os.path.normpath(filename)
        if safe.startswith("..") or os.path.isabs(safe):
            self._send_error(403, "Forbidden")
            return
        filepath = os.path.join(STATIC_DIR, safe)
        # Chốt bằng realpath: symlink/escape trick (vd "sub/../../etc/passwd")
        # qua được normpath nhưng không được rời khỏi STATIC_DIR.
        if not os.path.realpath(filepath).startswith(os.path.realpath(STATIC_DIR) + os.sep):
            self._send_error(403, "Forbidden")
            return
        if not os.path.isfile(filepath):
            self._send_error(404, "Not found")
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
        self.wfile.write(body)

    # --- Handlers ---

    def _handle_get(self, include_body=True):
        parsed = urlparse(self.path)
        path = parsed.path
        if path in ("/", "/index.html"):
            self._serve_static("index.html")
        elif path == "/api/models":
            query = parse_qs(parsed.query)
            url, err = validate_ollama_url(query.get("url", [DEFAULT_OLLAMA_URL])[0])
            if err:
                self._send_json(400, {"error": err})
                return
            models, fetch_err = fetch_models(url)
            resp = {"models": models, "default": DEFAULT_MODEL}
            if fetch_err:
                resp["error"] = fetch_err
            self._send_json(200, resp)
        elif path.startswith("/static/"):
            self._serve_static(path[len("/static/"):])
        else:
            self._send_error(404, "Not found")

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
        try:
            body = self._read_json()
        except BodyTooLarge:
            self._send_error(413, "Request body too large")
            return
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
        self.end_headers()

        def on_chunk(text):
            # Client ngắt kết nối → raise để stream_chat ngừng đọc upstream
            # luôn thay vì tiếp tục pull hết token từ Ollama vô ích.
            self.wfile.write(text.encode("utf-8"))
            self.wfile.flush()

        try:
            status, error = stream_chat(ollama_url, payload, on_chunk)
        except (BrokenPipeError, ConnectionResetError):
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
        try:
            body = self._read_json()
        except BodyTooLarge:
            self._send_error(413, "Request body too large")
            return
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
        if not model:
            self._send_error(400, "No model provided")
            return
        info = fetch_model_info(ollama_url, model)
        if info is None:
            self._send_error(404, "Model info not found")
            return
        self._send_json(200, info)

    # --- Utility ---

    def _read_json(self):
        try:
            return json.loads(self._read_body().decode("utf-8"))
        except BodyTooLarge:
            # Re-raise để caller trả 413 thay vì 400 chung chung
            raise
        except (ValueError, UnicodeDecodeError):
            self._send_error(400, "Invalid JSON body")
            return None
