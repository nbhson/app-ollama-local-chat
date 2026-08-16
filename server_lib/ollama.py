"""Ollama API client: models, model info, and streaming chat."""

import json
import urllib.request
import urllib.error

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


def _request(url, path, payload=None, timeout=300):
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


def _decode_json(body):
    try:
        return json.loads(body.decode("utf-8"))
    except Exception:
        return None


def fetch_models(ollama_url):
    status, body = _request(ollama_url, "/api/tags")
    if status != 200:
        return []
    data = _decode_json(body)
    if not data:
        return []
    return [m.get("name", "") for m in data.get("models", [])]


def fetch_model_info(ollama_url, model):
    status, body = _request(ollama_url, "/api/show", {"model": model})
    if status != 200:
        return None
    data = _decode_json(body)
    if not data:
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


def _extract_error(err):
    try:
        return json.loads(err.read().decode("utf-8")).get("error", str(err))
    except Exception:
        return str(err)


def stream_chat(ollama_url, payload, on_chunk):
    """Stream /api/chat, calling on_chunk(text) with NDJSON per token."""
    url = ollama_url.rstrip("/") + "/api/chat"
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(url, data=data,
                                 headers={"Content-Type": "application/json"},
                                 method="POST")
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
                    obj = _decode_json(line)
                    if not obj:
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
        return e.code, _extract_error(e)
    except Exception as e:
        return 0, str(e)