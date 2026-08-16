#!/usr/bin/env python3
"""Ollama Chat Web - Local chat UI with terminal-like streaming."""
import json, mimetypes, os, urllib.request, urllib.error
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

DEFAULT_OLLAMA_URL = "http://localhost:11434"
DEFAULT_MODEL = "gemma4:12b-mlx"
DEFAULT_TEMPERATURE = 0.7
DEFAULT_SYSTEM_PROMPT = "You are a helpful assistant."
STATIC_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "static")
PORT = 8080

def ollama_request(url, path, payload=None, timeout=300):
    data = None
    headers = {"Content-Type": "application/json"}
    if payload is not None:
        data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(url.rstrip("/") + path, data=data, headers=headers,
                                 method="POST" if payload is not None else "GET")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, resp.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()
    except Exception as e:
        return 0, str(e).encode("utf-8")

def fetch_models(ollama_url):
    status, body = ollama_request(ollama_url, "/api/tags")
    if status != 200:
        return []
    try:
        data = json.loads(body.decode("utf-8"))
        return [m.get("name", "") for m in data.get("models", [])]
    except Exception:
        return []

# Capabilities below are not exposed as standard Ollama "capabilities" fields.
# Ollama officially reports vision/tools via /api/show; thinking/audio are
# inferred from well-known model families so the UI can display them.
THINKING_FAMILIES = {
    "qwen2.5", "qwen3", "deepseek-r1", "deepseek-v3", "gemma3",
    "mistral", "granite4-dense", "olmo", "command-r", "command-a",
}
AUDIO_FAMILIES = {
    "qwen2.5-omni", "qwen3-omni", "smollm2", "llama3.2",
}

def fetch_model_info(ollama_url, model):
    status, body = ollama_request(ollama_url, "/api/show", {"model": model})
    if status != 200:
        return None
    try:
        data = json.loads(body.decode("utf-8"))
    except Exception:
        return None
    caps = data.get("capabilities", []) or []
    details = data.get("details", {}) or {}
    family = (details.get("family") or "").lower()
    supports = {
        "vision": "vision" in caps,
        "tools": "tools" in caps,
        "thinking": "thinking" in caps or any(f in family for f in THINKING_FAMILIES),
        "audio": "audio" in caps or any(f in family for f in AUDIO_FAMILIES),
    }
    return {
        "name": model,
        "family": details.get("family", ""),
        "capabilities": caps,
        "supports": supports,
    }

def stream_chat(ollama_url, payload, on_chunk):
    url = ollama_url.rstrip("/") + "/api/chat"
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json"}, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=600) as resp:
            buffer = b""
            while True:
                chunk = resp.read(4096)
                if not chunk:
                    break
                buffer += chunk
                while b"\n" in buffer:
                    line, buffer = buffer.split(b"\n", 1)
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        obj = json.loads(line.decode("utf-8"))
                    except json.JSONDecodeError:
                        continue
                    if obj.get("error"):
                        return 500, obj["error"]
                    msg = obj.get("message", {})
                    thinking = msg.get("thinking", "")
                    if thinking:
                        on_chunk(json.dumps({"t": "think", "d": thinking}) + "\n")
                    content = msg.get("content", "")
                    if content:
                        on_chunk(json.dumps({"t": "content", "d": content}) + "\n")
                    if obj.get("done"):
                        return 200, None
            return 200, None
    except urllib.error.HTTPError as e:
        try:
            err = json.loads(e.read().decode("utf-8")).get("error", str(e))
        except Exception:
            err = str(e)
        return e.code, err
    except Exception as e:
        return 0, str(e)

class ChatHandler(BaseHTTPRequestHandler):
    server_version = "OllamaChat/1.0"

    def log_message(self, format, *args):
        pass

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
        try:
            body = json.loads(self._read_body().decode("utf-8"))
        except Exception:
            self._send_error(400, "Invalid JSON body")
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

    def _handle_model_info(self):
        try:
            body = json.loads(self._read_body().decode("utf-8"))
        except Exception:
            self._send_error(400, "Invalid JSON body")
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

def main():
    server = ThreadingHTTPServer(("127.0.0.1", PORT), ChatHandler)
    print(f"Ollama Chat running at http://localhost:{PORT}")
    print(f"Default Ollama URL: {DEFAULT_OLLAMA_URL}")
    print(f"Default model: {DEFAULT_MODEL}")
    print("Press Ctrl+C to stop.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down...")
        server.shutdown()

if __name__ == "__main__":
    main()
