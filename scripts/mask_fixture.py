#!/usr/bin/env python3
"""Maskiert identifizierende Werte in RutOS-API-Antworten (stdin → stdout, oder Dateien in-place)."""
import ipaddress
import json
import re
import sys

# Schlüssel werden in Teile zerlegt (snake_case, camelCase, Ziffern), damit auch
# macEth, sim1_boot_iccid oder serial_number erfasst werden
SENSITIVE = {"imei", "imsi", "iccid", "serial", "mac", "macaddr", "hwaddr", "bssid", "cellid", "tac", "lac",
             "token", "ssid", "hostname", "identifier", "psk", "key", "password", "passwd", "secret",
             "lat", "latitude", "lon", "lng", "longitude", "alt", "altitude"}
SENSITIVE_PAIRS = {("wan", "ip"), ("public", "ip")}
# Zahlen/Einstellungen zu solchen Feldern sind unkritisch, z. B. bssid_limit
HARMLESS = {"limit", "count", "num", "max", "min", "len", "length", "enabled", "policy", "type"}
IP = re.compile(r"^[0-9a-fA-F:.]+(/\d+)?$")
MAC = re.compile(r"[0-9A-Fa-f]{2}(?:[:-][0-9A-Fa-f]{2}){5}")
# MAC ohne Trennzeichen, z. B. "macEth": "001122AABBCC" (mind. ein Buchstabe, sonst eher ein Zähler)
MAC_BARE = re.compile(r"^(?=.*[A-Fa-f])[0-9A-Fa-f]{12}$")
macs = {}


def mask_mac(mac):
    # Gleiche MAC → gleicher Platzhalter, verschiedene bleiben unterscheidbar
    norm = re.sub(r"[:-]", "", mac).upper()
    n = macs.setdefault(norm, len(macs) + 1)
    return f"02:00:00:00:00:{n:02X}"


def sensitive(key):
    if "/" in key:  # ACL-Pfade wie /password_policy/config/* oder services/modbus/modbus_serial_client
        return False
    parts = [p.lower() for p in re.findall(r"[A-Z]?[a-z]+|[A-Z]+(?![a-z])", key)]
    if any(p in HARMLESS for p in parts):
        return False
    return any(p in SENSITIVE for p in parts) or any(pair in SENSITIVE_PAIRS for pair in zip(parts, parts[1:]))


def mask_ip(v):
    try:
        ip = ipaddress.ip_interface(v).ip
    except ValueError:
        return v
    # Private/lokale Adressen sind unkritisch und für Tests nützlich
    if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_unspecified:
        return v
    return "2001:db8::1" if ip.version == 6 else "203.0.113.1"


def walk(o, key=""):
    if isinstance(o, dict):
        # MACs stehen auch als Schlüssel, z. B. in der assoclist der WLAN-Clients
        return {MAC.sub(lambda m: mask_mac(m[0]), k): walk(v, k) for k, v in o.items()}
    if isinstance(o, list):
        return [walk(x, key) for x in o]
    if sensitive(key) and isinstance(o, (str, int, float)) and not isinstance(o, bool) and o not in ("N/A", ""):
        return "XXXX"
    if isinstance(o, str) and MAC_BARE.match(o):
        return mask_mac(o)
    if isinstance(o, str) and MAC.search(o):
        return MAC.sub(lambda m: mask_mac(m[0]), o)
    if isinstance(o, str) and IP.match(o) and any(c in o for c in ".:"):
        return mask_ip(o)
    return o


def collect(o, found):
    """Werte sensibler Text-Felder sammeln, um sie auch in anderen Feldern zu ersetzen (z. B. 'ap "SSID"')."""
    if isinstance(o, dict):
        for k, v in o.items():
            if sensitive(k) and isinstance(v, str) and len(v) >= 4 and v not in ("N/A", "XXXX"):
                found.add(v)
            collect(v, found)
    elif isinstance(o, list):
        for x in o:
            collect(x, found)
    return found


def mask_text(text):
    data = json.loads(text)
    out = json.dumps(walk(data), indent=2, ensure_ascii=False) + "\n"
    for v in sorted(collect(data, set()), key=len, reverse=True):
        out = out.replace(json.dumps(v, ensure_ascii=False)[1:-1], "XXXX")
    return out


if __name__ == "__main__":
    if len(sys.argv) > 1:
        for path in sys.argv[1:]:
            with open(path) as f:
                out = mask_text(f.read())
            with open(path, "w") as f:
                f.write(out)
    else:
        sys.stdout.write(mask_text(sys.stdin.read()))
