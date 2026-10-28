#!/usr/bin/env python3
"""Ollama Chat Web - entry point.

Run: python3 server.py
"""

from http.server import ThreadingHTTPServer

from server_lib.config import PORT, DEFAULT_OLLAMA_URL, DEFAULT_MODEL
from server_lib.handler import ChatHandler


class ChatServer(ThreadingHTTPServer):
    # daemon_threads: request handler còn treo (vd stream dài) không chặn
    # process exit khi Ctrl+C.
    daemon_threads = True
    allow_reuse_address = True


def main():
    server = ChatServer(("127.0.0.1", PORT), ChatHandler)
    print(f"Ollama Chat running at http://localhost:{PORT}")
    print(f"Default Ollama URL: {DEFAULT_OLLAMA_URL}")
    print(f"Default model: {DEFAULT_MODEL}")
    print("Press Ctrl+C to stop.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        # shutdown() gọi từ CÙNG thread đang chạy serve_forever sẽ deadlock
        # (serve_forever chờ chính nó kết thúc). serve_forever đã thoát qua
        # exception — chỉ cần đóng socket là đủ.
        print("\nShutting down...")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
