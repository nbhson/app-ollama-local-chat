"""Configuration constants for the Ollama Chat server."""

import ipaddress
import os
from urllib.parse import urlparse

DEFAULT_OLLAMA_URL = "http://localhost:11434"
DEFAULT_MODEL = "gemma4:12b-mlx"
DEFAULT_TEMPERATURE = 0.7
DEFAULT_SYSTEM_PROMPT = "You are a helpful assistant."
PORT = 8080

STATIC_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "static")

# ── SSRF protection ──────────────────────────────────────────────────────────
# The client can pass an arbitrary ollama_url; without validation this server
# becomes an SSRF proxy into the host network (cloud metadata endpoints,
# internal services). Guards:
#   1. Only http/https schemes.
#   2. Cloud metadata hosts are ALWAYS denied (they are never valid Ollama
#      endpoints): AWS/GCP/Azure/OpenStack metadata IPs and hostnames.
#   3. Optional strict whitelist via ALLOWED_OLLAMA_HOSTS (comma-separated
#      hostnames, e.g. "localhost,ollama.internal"). When set, only these
#      hosts are accepted.
_BLOCKED_METADATA_HOSTS = {
    "169.254.169.254",          # AWS / OpenStack / Azure (link-local)
    "metadata.google.internal",  # GCP
    "metadata.goog",
    "100.100.100.200",           # Alibaba Cloud metadata
}


def validate_ollama_url(url):
    """Return (cleaned_url, None) if safe, or (None, reason) if rejected."""
    if not isinstance(url, str) or not url.strip():
        return None, "Missing ollama_url"
    url = url.strip()
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https"):
        return None, "Only http/https URLs are allowed"
    if not parsed.hostname:
        return None, "URL has no hostname"
    host = parsed.hostname.lower()

    # Always deny cloud metadata endpoints (SSRF classics)
    if host in _BLOCKED_METADATA_HOSTS:
        return None, "Blocked host (cloud metadata endpoint)"
    try:
        addr = ipaddress.ip_address(host)
        if addr.is_link_local or addr.is_reserved:
            return None, "Blocked host (link-local/reserved address)"
    except ValueError:
        pass  # hostname, not an IP literal

    # Optional strict whitelist
    allowed = os.environ.get("ALLOWED_OLLAMA_HOSTS", "").strip()
    if allowed:
        whitelist = {h.strip().lower() for h in allowed.split(",") if h.strip()}
        if host not in whitelist:
            return None, "Host not in ALLOWED_OLLAMA_HOSTS whitelist"

    return url.rstrip("/"), None
