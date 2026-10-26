#!/usr/bin/env bash
# Alle Tests: Parser-Unit-Tests + Client gegen Mock-Router (HTTP und HTTPS mit selbstsigniertem Zertifikat)
set -euo pipefail
cd "$(dirname "$0")/.."
tmp=$(mktemp -d)
trap 'kill $(jobs -p) 2>/dev/null; rm -rf "$tmp"' EXIT

gjs -m test/parse-test.js

# Übersetzungen: Deutsch aus po/de.po, andere Sprachen fallen auf Englisch zurück
# (LANGUAGE wirkt nur mit einer echten Locale, nicht mit LANG=C)
mkdir -p "$tmp/locale/de/LC_MESSAGES"
msgfmt --check -o "$tmp/locale/de/LC_MESSAGES/teltonika-indicator.mo" po/de.po
LANG=de_DE.UTF-8 LANGUAGE=de gjs -m test/i18n-test.js "$tmp/locale" "Zu SIM 2 wechseln"
LANG=de_DE.UTF-8 LANGUAGE=fr gjs -m test/i18n-test.js "$tmp/locale" "Switch to SIM 2"

openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj /CN=mock-router \
    -keyout "$tmp/key.pem" -out "$tmp/cert.pem" 2>/dev/null
fp=$(openssl x509 -in "$tmp/cert.pem" -noout -fingerprint -sha256 | cut -d= -f2)

python3 test/mock_router.py 18080 & 
python3 test/mock_router.py 18443 "$tmp/cert.pem" "$tmp/key.pem" &
sleep 0.5

echo "--- HTTP";  gjs -m test/client-test.js http://127.0.0.1:18080
echo "--- HTTPS"; gjs -m test/client-test.js https://127.0.0.1:18443 "$fp"
