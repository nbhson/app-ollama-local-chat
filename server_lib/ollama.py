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

# Listing/info phải trả nhanh — nếu Ollama chết thì UI không nên treo cả phút.
LIST_TIMEOUT = 10
# Stream chat: model chạy lâu là bình thường.
STREAM_TIMEOUT = 600


def _request(url, path, payload=None, timeout=LIST_TIMEOUT):
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
    """Return (models, error). error is None khi thành công."""
    status, body = _request(ollama_url, "/api/tags", timeout=LIST_TIMEOUT)
    if status == 0:
        return [], "Cannot connect to Ollama: " + body.decode("utf-8", "replace")
    if status != 200:
        return [], "Ollama returned HTTP %d" % status
    data = _decode_json(body)
    if not data:
        return [], "Invalid response from Ollama"
    return [m.get("name", "") for m in data.get("models", [])], None


def fetch_model_info(ollama_url, model):
    """Return (info, error, upstream_status).

    upstream_status: HTTP status từ Ollama, hoặc 0 khi không kết nối được —
    caller dùng để phân biệt 404 (model không tồn tại) với 502 (upstream hỏng).
    """
    status, body = _request(ollama_url, "/api/show", {"model": model}, timeout=LIST_TIMEOUT)
    if status == 0:
        return None, "Cannot connect to Ollama: " + body.decode("utf-8", "replace"), 0
    if status != 200:
        return None, "Ollama returned HTTP %d for model '%s'" % (status, model), status
    data = _decode_json(body)
    if not data:
        return None, "Invalid response from Ollama", status
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
    }, None, status


def _extract_error(err):
    try:
        return json.loads(err.read().decode("utf-8")).get("error", str(err))
    except Exception:
        return str(err)


def stream_chat(ollama_url, payload, on_chunk):
    """Stream /api/chat, calling on_chunk(text) with NDJSON per token.

    on_chunk được phép raise ConnectionError (client ngắt) — exception
    propagate lên caller để ngừng đọc upstream ngay.
    """
    url = ollama_url.rstrip("/") + "/api/chat"
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(url, data=data,
                                 headers={"Content-Type": "application/json"},
                                 method="POST")
    try:
        with urllib.request.urlopen(req, timeout=STREAM_TIMEOUT) as resp:
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
                        prompt_tokens = obj.get("prompt_eval_count", 0) or 0
                        output_tokens = obj.get("eval_count", 0) or 0
                        # Chỉ gửi progress frame khi có số liệu thật — tránh
                        # spam 2 frame rác "0 tokens" cho mỗi token content.
                        if prompt_tokens or output_tokens:
                            prog = {
                                "t": "progress",
                                "prompt_tokens": prompt_tokens,
                                "output_tokens": output_tokens,
                                "eval_duration": obj.get("eval_duration", 0) or 0,
                                "total_duration": obj.get("total_duration", 0) or 0,
                            }
                            on_chunk(json.dumps(prog) + "\n")
                        on_chunk(json.dumps({"t": "content", "d": content}) + "\n")
                    if obj.get("done"):
                        stats = {
                            "t": "stats",
                            "prompt_tokens": obj.get("prompt_eval_count", 0) or 0,
                            "output_tokens": obj.get("eval_count", 0) or 0,
                            "eval_duration": obj.get("eval_duration", 0) or 0,
                            "total_duration": obj.get("total_duration", 0) or 0,
                        }
                        on_chunk(json.dumps(stats) + "\n")
                        return 200, None
            return 200, None
    except ConnectionError:
        # Client ngắt kết nối — raise lên để caller ngừng luôn, không gửi error frame.
        # (gồm BrokenPipeError/ConnectionResetError và ConnectionError do
        # on_chunk raise khi ghi xuống client fail.)
        raise
    except urllib.error.HTTPError as e:
        return e.code, _extract_error(e)
    except Exception as e:
        return 0, str(e)
