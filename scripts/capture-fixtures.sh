#!/usr/bin/env bash
# Echte API-Antworten vom Router als Test-Fixtures sichern.
# Aufruf: scripts/capture-fixtures.sh 192.168.1.1 benutzer
# Identifizierende Werte (IMEI, ICCID, MACs, SSIDs, öffentliche IPs …) werden maskiert.
set -euo pipefail
host=${1:?Router-Adresse}; user=${2:?Benutzer}
out="$(dirname "$0")/../test/fixtures"
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
resp="$tmp/resp"
base="https://$host/api"

# Zertifikat anzeigen und den öffentlichen Schlüssel pinnen statt curl -k
cert=$(openssl s_client -connect "$host:443" -servername "$host" </dev/null 2>/dev/null | openssl x509) \
    || { echo "Kein Zertifikat von $host:443"; exit 1; }
echo "Zertifikat von $host:"
openssl x509 -noout -fingerprint -sha256 <<<"$cert"
read -rp "Fingerprint stimmt mit dem Router überein? [j/N] " ok
[[ $ok == [jJyY] ]] || exit 1
pin=$(openssl x509 -noout -pubkey <<<"$cert" | openssl pkey -pubin -outform der | openssl dgst -sha256 -binary | base64)
curl_() { curl -s --insecure --pinnedpubkey "sha256//$pin" "$@"; }

read -rsp "Passwort für $user@$host: " pass; echo
# Passwort und Token nicht als Argumente übergeben (sonst in der Prozessliste sichtbar)
PW="$pass" USR="$user" python3 -I -c 'import json, os; print(json.dumps({"username": os.environ["USR"], "password": os.environ["PW"]}))' \
    > "$tmp/login.json"
unset pass
login=$(curl_ -X POST "$base/login" -H 'Content-Type: application/json' --data @"$tmp/login.json")
rm -f "$tmp/login.json"
python3 -I -c 'import json,sys; print("Authorization: Bearer " + json.load(sys.stdin)["data"]["token"])' \
    <<<"$login" > "$tmp/auth" || { echo "Login fehlgeschlagen"; exit 1; }
echo "Login ok"

mask() { python3 -I "$(dirname "$0")/mask_fixture.py"; }

for ep in unauthorized/status modems/status system/device/status system/device/usage/status \
          failover/status sim_cards/status data_limit/status interfaces/config \
          gps/position/status users/acls/options sim_switch/status; do
    name="rutm30_$(tr '/' '_' <<<"$ep").json"
    code=$(curl_ -o "$resp" -w '%{http_code}' -H @"$tmp/auth" "$base/$ep")
    if [[ $code == 200 ]]; then
        mask < "$resp" > "$out/$name"
        echo "  $ep → $name"
    else
        echo "  $ep → HTTP $code (übersprungen)"
    fi
done
curl_ -X POST -H @"$tmp/auth" "$base/logout" >/dev/null || true
