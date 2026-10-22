#!/usr/bin/env python3
"""Mock-RutOS-Router für Tests: python3 test/mock_router.py PORT [CERT KEY]

Endpunkte: POST /api/login, GET /api/modems/status, GET /api/sim_cards/status,
PUT /api/sim_cards/config/{id}, POST /api/modems/{id}/actions/{switch_sim,restart_connection},
GET /api/data_limit/status, GET /api/interfaces/config, POST /api/data_limit/actions/clear,
POST /_test/expire (alle Tokens ungültig), POST /_test/fixture?name=…,
GET /_test/logins (Anzahl Login-Versuche), GET /api/_test/{big,slow,redirect} (Robustheit des Clients)
"""
import json, secrets, ssl, sys, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse, parse_qs

FIX = Path(__file__).parent / "fixtures"
# Benutzer → darf schreiben (SIM-Wechsel)?
USERS = {"monitor": ("secret", True), "readonly": ("secret", False)}
tokens = {}  # token → Benutzer
state = {"fixture": "modems_status.json", "active": {}, "logins": 0}  # modem → (slot, esim_profile)
sim_cards = json.loads((FIX / "rutm30_sim_cards_status.json").read_text())["data"]
data_limits = json.loads((FIX / "rutm30_data_limit_status.json").read_text())["data"]
interfaces = json.loads((FIX / "rutm30_interfaces_config.json").read_text())["data"]
EMPTY_SLOTS = {2}  # wie beim RUTM30 des Nutzers: Slot 2 unbelegt


def active_interface(modem):
    slot, profile = state["active"].get(modem, (1, None))
    return next((i["id"] for i in interfaces if i.get("modem") == modem and i.get("sim") == str(slot)
                 and i.get("esim_profile") == profile), None)


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def reply(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        try:
            self.wfile.write(body)
        except OSError:  # Client bricht ab, z. B. bei zu großer Antwort
            pass

    def do_POST(self):
        u = urlparse(self.path)
        data = self.rfile.read(int(self.headers.get("Content-Length") or 0))
        if u.path == "/api/login":
            state["logins"] += 1
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
            if not self.can_write():
                return
            # Nächster Slot in Reihenfolge, auch wenn er leer ist
            cards = [c for c in sim_cards if c["modem"] == parts[2]]
            cur = state["active"].get(parts[2], (1, None))
            idx = next((i for i, c in enumerate(cards)
                        if int(c["sim"]) == cur[0] and c.get("esim_profile") == cur[1]), -1)
            nxt = cards[(idx + 1) % len(cards)]
            state["active"][parts[2]] = (int(nxt["sim"]), nxt.get("esim_profile"))
            return self.reply(200, {"success": True})
        if parts[:2] == ["api", "modems"] and parts[3:] == ["actions", "restart_connection"]:
            if not self.can_write():
                return
            # Verbindung kommt mit der Standard-SIM zurück
            card = next((c for c in sim_cards if c["modem"] == parts[2] and c.get("primary") == "1"), None)
            if card:
                state["active"][parts[2]] = (int(card["sim"]), card.get("esim_profile"))
            return self.reply(200, {"success": True})
        if u.path == "/api/data_limit/actions/clear":
            if not self.can_write():
                return
            iface = (json.loads(data or b"{}").get("data") or {}).get("interface")
            # Wie RutOS: nur das Interface der aktiven SIM
            if iface != active_interface("2-1"):
                return self.reply(400, {"success": False, "errors": [{"code": 100, "error": "Interface is not active"}]})
            next(d for d in data_limits if d["id"] == iface)["data_used"] = "0"
            return self.reply(200, {"success": True})
        if u.path == "/_test/expire":
            tokens.clear()
            return self.reply(200, {"success": True})
        if u.path == "/_test/fixture":
            state["fixture"] = parse_qs(u.query)["name"][0]
            return self.reply(200, {"success": True})
        self.reply(404, {"success": False})

    def can_write(self):
        user = self.user()
        if not user:
            self.reply(401, {"success": False, "errors": [{"code": 120, "error": "Unauthorized access"}]})
            return False
        if not USERS[user][1]:
            self.reply(403, {"success": False, "errors": [{"code": 122, "error": "Forbidden", "source": "ACL"}]})
            return False
        return True

    def do_PUT(self):
        u = urlparse(self.path)
        data = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"{}")
        parts = u.path.strip("/").split("/")
        if parts[:3] == ["api", "sim_cards", "config"] and len(parts) == 4:
            if not self.can_write():
                return
            card = next((c for c in sim_cards if c["section_name"] == parts[3]), None)
            if not card:
                return self.reply(404, {"success": False, "errors": [{"code": 404, "error": "Not found"}]})
            if data.get("data", {}).get("primary") == "1":
                for c in sim_cards:
                    if c["modem"] == card["modem"]:
                        c.pop("primary", None)
                card["primary"] = "1"
            return self.reply(200, {"success": True, "data": card})
        self.reply(404, {"success": False})

    def user(self):
        auth = self.headers.get("Authorization", "")
        return tokens.get(auth[7:]) if auth.startswith("Bearer ") else None

    def do_GET(self):
        if self.path == "/_test/logins":
            return self.reply(200, {"logins": state["logins"]})
        if self.path == "/api/_test/big":
            return self.reply(200, {"success": True, "data": "x" * (2 * 1024 * 1024)})
        if self.path == "/api/_test/redirect":
            self.send_response(302)
            self.send_header("Location", "http://127.0.0.1:1/api/modems/status")
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        if self.path == "/api/_test/slow":
            # Ohne Content-Length, alle 0,5 s ein Byte – nie ein I/O-Timeout, aber endlos
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            try:
                for _ in range(20):
                    self.wfile.write(b" ")
                    self.wfile.flush()
                    time.sleep(0.5)
            except OSError:
                pass
            return
        if not self.user():
            return self.reply(401, {"success": False, "errors": [{"code": 120, "error": "Unauthorized access"}]})
        if self.path == "/api/modems/status":
            data = json.loads((FIX / state["fixture"]).read_text())
            for m in data.get("data", []):
                if m.get("id") in state["active"]:
                    m["active_sim"], profile = state["active"][m["id"]]
                    if profile:
                        m["esim_profile"] = profile
                    else:
                        m.pop("esim_profile", None)
                    if m["active_sim"] in EMPTY_SLOTS:
                        m["simstate"] = "Not inserted"
                        for k in ("conntype", "ntype", "rssi", "rsrp", "rsrq", "sinr", "band", "ca_signal"):
                            m.pop(k, None)
            return self.reply(200, data)
        if self.path == "/api/data_limit/status":
            return self.reply(200, {"success": True, "data": data_limits})
        if self.path == "/api/interfaces/config":
            if not USERS[self.user()][1]:
                return self.reply(403, {"success": False, "errors": [{"code": 122, "error": "Forbidden", "source": "ACL"}]})
            return self.reply(200, {"success": True, "data": interfaces})
        if self.path == "/api/sim_cards/status":
            return self.reply(200, {"success": True, "data": sim_cards})
        self.reply(404, {"success": False})


if __name__ == "__main__":
    srv = ThreadingHTTPServer(("127.0.0.1", int(sys.argv[1])), H)
    if len(sys.argv) > 3:
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        ctx.load_cert_chain(sys.argv[2], sys.argv[3])
        srv.socket = ctx.wrap_socket(srv.socket, server_side=True)
    srv.serve_forever()
