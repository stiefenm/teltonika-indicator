# Teltonika Router Indicator

GNOME-Shell-Erweiterung (GNOME 48–50), die den Mobilfunk-Status eines Teltonika-Routers
mit RutOS 7.x in der oberen Leiste anzeigt, z. B. `5G B3+B20+n78 −95 dBm`.
Das Icon ist nach Signalqualität eingefärbt. Das Popup zeigt Betreiber, Netz, Band,
RSSI/RSRP/RSRQ/SINR, SIM, Modemtemperatur und Datenzähler.

Status: **v0.1 (MVP)**, getestet gegen einen Mock-Router, noch nicht am echten RUTM30.
Hintergrund: [docs/BRIEF.md](docs/BRIEF.md), API-Notizen: [docs/API.md](docs/API.md).

## Installation

```bash
make install          # packt und installiert nach ~/.local/share/gnome-shell/extensions
# Wayland: einmal ab- und wieder anmelden
gnome-extensions enable teltonika-indicator@mstiefenhofer
gnome-extensions prefs teltonika-indicator@mstiefenhofer
```

In den Einstellungen Router-Adresse, Benutzer und Passwort eintragen und „Testen“ klicken.
Das Passwort liegt im GNOME-Schlüsselbund. Empfohlen ist ein eigener RutOS-Benutzer mit Leserechten.
Für den optionalen SIM-Wechsel im Menü (Einstellung „SIM-Wechsel im Menü anbieten“)
braucht er zusätzlich Schreibrecht für Netzwerk → Mobilfunk.

## Funktionsweise

- RutOS-REST-API: `POST /api/login` holt ein Token, `GET /api/modems/status` die Werte.
  Das Token wird kurz vor Ablauf oder nach einem 401 erneuert.
- Selbstsigniertes Zertifikat: Der SHA-256-Fingerprint wird beim ersten Kontakt gepinnt (TOFU).
  Ändert er sich, wird die Verbindung blockiert, bis er in den Einstellungen gelöscht wird.
- Ist der Router nicht erreichbar, wird das Abfrageintervall still verlängert (exponentieller Backoff bis 5 min).
- Bei mehreren Modems wird das erste mit Signal angezeigt.
- SIM-Wechsel: `POST /api/modems/{id}/actions/switch_sim` nach Bestätigung im Dialog, danach Abfrage
  alle 5 s, bis die neue SIM gemeldet wird. Das Ergebnis kommt als Benachrichtigung.

## Entwicklung

```
extension.js      Panel-Indicator, Popup, Polling/Backoff
prefs.js          Adw-Einstellungen inkl. Verbindungstest
lib/client.js     Soup-3-Client: Login, Token, Cert-Pinning
lib/parse.js      Normalisierung/Formatierung (reine Funktionen)
lib/secret.js     libsecret-Wrapper
test/             Parser-Tests, Mock-Router, Client-Tests
scripts/capture-fixtures.sh   echte Router-Antworten (maskiert) als Fixtures sichern
```

```bash
make test         # Parser-Tests + Client gegen Mock-Router (HTTP und HTTPS)
journalctl -f -o cat /usr/bin/gnome-shell | grep -i teltonika
```
