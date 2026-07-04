"""Tiny CORS-adding reverse proxy for Lemonade Server.

Only needed if Lemonade itself doesn't send Access-Control-Allow-Origin headers
(see SETUP.md, step 4). Listens on :8001 and forwards everything to :13305.

Usage:  python tools/cors-proxy.py
Then:   tailscale serve --bg http://localhost:8001
"""
import http.server
import urllib.request
import urllib.error

UPSTREAM = "http://localhost:13305"
PORT = 8001

CORS_HEADERS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
}


class Proxy(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def _cors(self):
        for k, v in CORS_HEADERS.items():
            self.send_header(k, v)

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.send_header("Content-Length", "0")
        self.end_headers()

    def _forward(self, method):
        length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(length) if length else None
        req = urllib.request.Request(UPSTREAM + self.path, data=body, method=method)
        for h in ("Content-Type", "Authorization"):
            if self.headers.get(h):
                req.add_header(h, self.headers[h])
        try:
            with urllib.request.urlopen(req, timeout=300) as res:
                payload = res.read()
                self.send_response(res.status)
                self.send_header("Content-Type", res.headers.get("Content-Type", "application/json"))
                self.send_header("Content-Length", str(len(payload)))
                self._cors()
                self.end_headers()
                self.wfile.write(payload)
        except urllib.error.HTTPError as e:
            payload = e.read()
            self.send_response(e.code)
            self.send_header("Content-Length", str(len(payload)))
            self._cors()
            self.end_headers()
            self.wfile.write(payload)
        except Exception:
            self.send_response(502)
            self.send_header("Content-Length", "0")
            self._cors()
            self.end_headers()

    def do_GET(self):
        self._forward("GET")

    def do_POST(self):
        self._forward("POST")

    def log_message(self, fmt, *args):
        pass


if __name__ == "__main__":
    print(f"CORS proxy on :{PORT} -> {UPSTREAM}")
    http.server.ThreadingHTTPServer(("127.0.0.1", PORT), Proxy).serve_forever()
