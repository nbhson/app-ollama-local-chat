"""Configuration constants for the Ollama Chat server."""

import ipaddress
import os
import socket
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
#   3. Hostname is RESOLVED and every resulting IP is checked — blocks
#      DNS-rebind bypass (benign hostname pointing at 169.254.169.254).
#      NOTE: localhost/loopback and LAN IPs stay ALLOWED on purpose — this is
#      a local tool whose default Ollama endpoint is 127.0.0.1:11434.
#      Set ALLOWED_OLLAMA_HOSTS to lock down further in shared environments.
#   4. Optional strict whitelist via ALLOWED_OLLAMA_HOSTS (comma-separated
#      hostnames, e.g. "localhost,ollama.internal"). When set, only these
#      hosts are accepted.
_BLOCKED_METADATA_HOSTS = {
    "169.254.169.254",          # AWS / OpenStack / Azure (link-local)
    "metadata.google.internal",  # GCP
    "metadata.goog",
    "100.100.100.200",           # Alibaba Cloud metadata
}


def _check_ip(addr):
    """Return rejection reason for a resolved IP, or None if allowed."""
    # Loopback (127.0.0.0/8, ::1) luôn cho phép — endpoint mặc định của
    # Ollama. Lưu ý trên Python 3.13+ ::1 có is_reserved=True nên phải
    # kiểm tra loopback TRƯỚC.
    if addr.is_loopback:
        return None
    if addr.is_link_local or addr.is_reserved:
        return "Blocked host (link-local/reserved address)"
    # Dải metadata Alibaba không nằm trong link-local/reserved chuẩn
    if addr == ipaddress.ip_address("100.100.100.200"):
        return "Blocked host (cloud metadata endpoint)"
    return None


def validate_ollama_url(url):
    """Return (cleaned_url, None) if safe, or (None, reason) if rejected."""
    if not isinstance(url, str) or not url.strip():
        return None, "Missing ollama_url"
    url = url.strip()
    try:
        parsed = urlparse(url)
    except ValueError:
        return None, "Invalid URL"
    if parsed.scheme not in ("http", "https"):
        return None, "Only http/https URLs are allowed"
    if not parsed.hostname:
        return None, "URL has no hostname"
    host = parsed.hostname.lower()

    # Always deny cloud metadata endpoints (SSRF classics)
    if host in _BLOCKED_METADATA_HOSTS:
        return None, "Blocked host (cloud metadata endpoint)"

    # Resolve hostname -> IP và kiểm tra từng kết quả (chống DNS-rebind)
    try:
        ipaddress.ip_address(host)
        resolved_ips = {host}
    except ValueError:
        try:
            infos = socket.getaddrinfo(host, None)
            resolved_ips = {info[4][0] for info in infos}
        except (socket.gaierror, OSError):
            return None, "Cannot resolve Ollama host"

    for ip_str in resolved_ips:
        try:
            addr = ipaddress.ip_address(ip_str)
        except ValueError:
            continue
        reason = _check_ip(addr)
        if reason:
            return None, reason

    # Optional strict whitelist
    allowed = os.environ.get("ALLOWED_OLLAMA_HOSTS", "").strip()
    if allowed:
        whitelist = {h.strip().lower() for h in allowed.split(",") if h.strip()}
        if host not in whitelist:
            return None, "Host not in ALLOWED_OLLAMA_HOSTS whitelist"

    return url.rstrip("/"), None
