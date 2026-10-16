#!/usr/bin/env python3
"""Mock-RutOS-Router für Tests: python3 test/mock_router.py PORT [CERT KEY]

Endpunkte: POST /api/login, GET /api/modems/status, POST /api/modems/{id}/actions/switch_sim,
POST /_test/expire (alle Tokens ungültig), POST /_test/fixture?name=…
"""
import json, secrets, ssl, sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse, parse_qs

FIX = Path(__file__).parent / "fixtures"
# Benutzer → darf schreiben (SIM-Wechsel)?
USERS = {"monitor": ("secret", True), "readonly": ("secret", False)}
tokens = {}  # token → Benutzer
state = {"fixture": "modems_status.json", "active_sim": {}}


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def reply(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        u = urlparse(self.path)
        data = self.rfile.read(int(self.headers.get("Content-Length") or 0))
        if u.path == "/api/login":
            try:
                req = json.loads(data)
            except ValueError:
                return self.reply(400, {"success": False})
            user = req.get("username")
            if user in USERS and req.get("password") == USERS[user][0]:
                t = secrets.token_hex(8)
                tokens[t] = user
                return self.reply(200, {"success": True, "data": {"username": user, "token": t, "expires": 299}})
            return self.reply(401, {"success": False, "errors": [{"code": 121, "error": "Authentication failed", "source": "Login"}]})
        parts = u.path.strip("/").split("/")
        if parts[:2] == ["api", "modems"] and parts[3:] == ["actions", "switch_sim"]:
            user = self.user()
            if not user:
                return self.reply(401, {"success": False, "errors": [{"code": 120, "error": "Unauthorized access"}]})
            if not USERS[user][1]:
                return self.reply(403, {"success": False, "errors": [{"code": 122, "error": "Forbidden", "source": "ACL"}]})
            cur = state["active_sim"].get(parts[2], 1)
            state["active_sim"][parts[2]] = 2 if cur == 1 else 1
            return self.reply(200, {"success": True})
        if u.path == "/_test/expire":
            tokens.clear()
            return self.reply(200, {"success": True})
        if u.path == "/_test/fixture":
            state["fixture"] = parse_qs(u.query)["name"][0]
            return self.reply(200, {"success": True})
        self.reply(404, {"success": False})

    def user(self):
        auth = self.headers.get("Authorization", "")
        return tokens.get(auth[7:]) if auth.startswith("Bearer ") else None

    def do_GET(self):
        if not self.user():
            return self.reply(401, {"success": False, "errors": [{"code": 120, "error": "Unauthorized access"}]})
        if self.path == "/api/modems/status":
            data = json.loads((FIX / state["fixture"]).read_text())
            for m in data.get("data", []):
                if m.get("id") in state["active_sim"]:
                    m["active_sim"] = state["active_sim"][m["id"]]
            return self.reply(200, data)
        self.reply(404, {"success": False})


if __name__ == "__main__":
    srv = ThreadingHTTPServer(("127.0.0.1", int(sys.argv[1])), H)
    if len(sys.argv) > 3:
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        ctx.load_cert_chain(sys.argv[2], sys.argv[3])
        srv.socket = ctx.wrap_socket(srv.socket, server_side=True)
    srv.serve_forever()
