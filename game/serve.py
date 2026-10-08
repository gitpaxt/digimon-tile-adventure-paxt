#!/usr/bin/env python3
"""Static file server for local dev that disables caching entirely, so
edited .js/.html/.css files are always served fresh — no more stale
browser-cache confusion during development."""
import http.server
import sys


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8642
    http.server.test(HandlerClass=NoCacheHandler, port=port)
