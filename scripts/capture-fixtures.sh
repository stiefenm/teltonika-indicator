#!/usr/bin/env bash
# Echte API-Antworten vom Router als Test-Fixtures sichern.
# Aufruf: scripts/capture-fixtures.sh 192.168.1.1 benutzer
# IMEI/IMSI/ICCID/Seriennummern werden maskiert.
set -euo pipefail
host=${1:?Router-Adresse}; user=${2:?Benutzer}
read -rsp "Passwort für $user@$host: " pass; echo
out="$(dirname "$0")/../test/fixtures"
resp=$(mktemp); trap 'rm -f "$resp"' EXIT
base="https://$host/api"

login=$(curl -sk -X POST "$base/login" -H 'Content-Type: application/json' \
    -d "$(python3 -c 'import json,sys; print(json.dumps({"username":sys.argv[1],"password":sys.argv[2]}))' "$user" "$pass")")
token=$(python3 -c 'import json,sys; print(json.load(sys.stdin)["data"]["token"])' <<<"$login") \
    || { echo "Login fehlgeschlagen: $login"; exit 1; }
echo "Login ok"

mask() {
    python3 -c '
import json, re, sys
SECRET = re.compile(r"^(imei|imsi|iccid|serial|mac|macaddr|cellid|token)$")
def walk(o):
    if isinstance(o, dict):
        return {k: ("XXXX" if SECRET.match(k) and isinstance(v, (str, int)) else walk(v)) for k, v in o.items()}
    if isinstance(o, list):
        return [walk(x) for x in o]
    return o
print(json.dumps(walk(json.load(sys.stdin)), indent=2, ensure_ascii=False))'
}

for ep in unauthorized/status modems/status system/device/status system/device/usage/status \
          interfaces/status failover/status sim_cards/status dhcp/leases/ipv4/status \
          wireless/interfaces/status gps/position/status users/acls/options sim_switch/status; do
    name="rutm30_$(tr '/' '_' <<<"$ep").json"
    code=$(curl -sk -o "$resp" -w '%{http_code}' -H "Authorization: Bearer $token" "$base/$ep")
    if [[ $code == 200 ]]; then
        mask < "$resp" > "$out/$name"
        echo "  $ep → $name"
    else
        echo "  $ep → HTTP $code (übersprungen)"
    fi
done
curl -sk -X POST -H "Authorization: Bearer $token" "$base/logout" >/dev/null || true
