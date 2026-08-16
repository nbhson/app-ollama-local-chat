#!/usr/bin/env python3
"""Ollama Chat Web - entry point.

Run: python3 server.py
"""

from http.server import ThreadingHTTPServer

from server_lib.config import PORT, DEFAULT_OLLAMA_URL, DEFAULT_MODEL
from server_lib.handler import ChatHandler


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