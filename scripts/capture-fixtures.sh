#!/usr/bin/env bash
# Echte API-Antworten vom Router als Test-Fixtures sichern.
# Aufruf: scripts/capture-fixtures.sh 192.168.1.1 benutzer
# Identifizierende Werte (IMEI, ICCID, MACs, SSIDs, öffentliche IPs …) werden maskiert.
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

mask() { python3 -I "$(dirname "$0")/mask_fixture.py"; }

for ep in unauthorized/status modems/status system/device/status system/device/usage/status \
          failover/status sim_cards/status data_limit/status interfaces/config \
          gps/position/status users/acls/options sim_switch/status; do
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
