"""HTTP request handler for the Ollama Chat web UI."""

import json
import mimetypes
import os
from http.server import BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs

from .config import (DEFAULT_OLLAMA_URL, DEFAULT_MODEL, DEFAULT_TEMPERATURE,
                     DEFAULT_SYSTEM_PROMPT, STATIC_DIR)
from .ollama import fetch_models, fetch_model_info, stream_chat


class ChatHandler(BaseHTTPRequestHandler):
    server_version = "OllamaChat/1.0"

    def log_message(self, format, *args):
        pass

    # --- Response helpers ---

    def _send_json(self, status, obj):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _send_error(self, status, msg):
        self._send_json(status, {"error": msg})

    def _read_body(self):
        length = int(self.headers.get("Content-Length", 0))
        return self.rfile.read(length) if length > 0 else b""

    def _serve_static(self, filename):
        safe = os.path.normpath(filename)
        if safe.startswith("..") or os.path.isabs(safe):
            self._send_error(403, "Forbidden")
            return
        filepath = os.path.join(STATIC_DIR, safe)
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
        self.end_headers()
        self.wfile.write(body)

    # --- Handlers ---

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path
        if path in ("/", "/index.html"):
            self._serve_static("index.html")
        elif path == "/api/models":
            query = parse_qs(parsed.query)
            url = query.get("url", [DEFAULT_OLLAMA_URL])[0]
            self._send_json(200, {"models": fetch_models(url), "default": DEFAULT_MODEL})
        elif path.startswith("/static/"):
            self._serve_static(path[len("/static/"):])
        else:
            self._send_error(404, "Not found")

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

    def _handle_chat(self):
        body = self._read_json()
        if body is None:
            return
        ollama_url = body.get("ollama_url", DEFAULT_OLLAMA_URL)
        model = body.get("model", DEFAULT_MODEL)
        messages = body.get("messages", [])
        temperature = body.get("temperature", DEFAULT_TEMPERATURE)
        system_prompt = body.get("system_prompt", DEFAULT_SYSTEM_PROMPT)

        if not messages:
            self._send_error(400, "No messages provided")
            return

        if system_prompt and (not messages or messages[0].get("role") != "system"):
            messages = [{"role": "system", "content": system_prompt}] + messages

        payload = {"model": model, "messages": messages, "stream": True,
                   "options": {"temperature": temperature}}

        self.send_response(200)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("X-Accel-Buffering", "no")
        self.end_headers()

        def on_chunk(text):
            try:
                self.wfile.write(text.encode("utf-8"))
                self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError):
                raise

        status, error = stream_chat(ollama_url, payload, on_chunk)
        if error:
            try:
                self.wfile.write(f"\n\n[ERROR] {error}".encode("utf-8"))
                self.wfile.flush()
            except Exception:
                pass

    # --- API: /api/model-info ---

    def _handle_model_info(self):
        body = self._read_json()
        if body is None:
            return
        ollama_url = body.get("ollama_url", DEFAULT_OLLAMA_URL)
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
        except Exception:
            self._send_error(400, "Invalid JSON body")
            return None