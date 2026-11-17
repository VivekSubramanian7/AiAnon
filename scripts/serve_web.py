"""
Serve the browser TMI (web/) locally with the same response headers Vercel will send (read from
web/vercel.json), so cross-origin isolation, CSP and caching behave like production.

    python3 scripts/serve_web.py [port]      # default 8079, then open http://localhost:8079
"""

import functools
import http.server
import json
import os
import re
import sys
import urllib.parse

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WEB = os.path.join(REPO, "web")
# Local-only extras for web/dev/check.html (never deployed): the mock memories and the Python fixtures.
DEV_MOUNTS = {
    "/samples/": os.path.join(REPO, "samples"),
    "/fixtures/": os.path.join(REPO, "tests", "web", "fixtures"),
}


def load_rules():
    with open(os.path.join(WEB, "vercel.json")) as f:
        config = json.load(f)
    # Vercel's "/(.*)" style sources are path-to-regexp; these simple ones translate directly.
    return [(re.compile("^" + rule["source"] + "$"), rule["headers"]) for rule in config.get("headers", [])]


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        ".js": "text/javascript", ".mjs": "text/javascript", ".json": "application/json",
        ".wasm": "application/wasm", ".woff2": "font/woff2", ".svg": "image/svg+xml",
    }
    rules = load_rules()

    def translate_path(self, path):
        for prefix, folder in DEV_MOUNTS.items():
            if path.startswith(prefix):
                rel = urllib.parse.unquote(path[len(prefix):].split("?", 1)[0])
                full = os.path.realpath(os.path.join(folder, rel))
                if full.startswith(os.path.realpath(folder) + os.sep):
                    return full
        return super().translate_path(path)

    def end_headers(self):
        path = self.path.split("?", 1)[0]
        cache_set = False
        for pattern, headers in self.rules:
            if pattern.match(path):
                for header in headers:
                    self.send_header(header["key"], header["value"])
                    cache_set |= header["key"].lower() == "cache-control"
        if not cache_set:
            self.send_header("Cache-Control", "no-cache")  # local edits show up on reload
        super().end_headers()

    def log_message(self, *args):
        pass


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8079
    handler = functools.partial(Handler, directory=WEB)
    print(f"TMI (browser) on http://localhost:{port}   (dev check: /dev/check.html?detective=1)")
    http.server.ThreadingHTTPServer(("127.0.0.1", port), handler).serve_forever()
