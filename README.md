# Teltonika Router Indicator

GNOME-Shell-Erweiterung (GNOME 48–50), die den Mobilfunk-Status eines Teltonika-Routers
mit RutOS 7.x in der oberen Leiste anzeigt, z. B. `5G B3+B20+n78 −95 dBm`.
Das Icon ist nach Signalqualität eingefärbt. Das Popup zeigt Betreiber, Netz, Band,
RSSI/RSRP/RSRQ/SINR, SIM, Modemtemperatur und Datenzähler.

Status: **v1.0**, getestet am Teltonika RUTM30 (RutOS 7.x) und gegen einen Mock-Router.
Hintergrund: [docs/BRIEF.md](docs/BRIEF.md), API-Notizen: [docs/API.md](docs/API.md).

## Installation

```bash
make install          # packt und installiert nach ~/.local/share/gnome-shell/extensions,
                      # dazu Starter + Icon nach ~/.local/share/applications bzw. icons
# Wayland: einmal ab- und wieder anmelden
gnome-extensions enable teltonika-indicator@mstiefenhofer
gnome-extensions prefs teltonika-indicator@mstiefenhofer
```

In den Einstellungen Router-Adresse, Benutzer und Passwort eintragen und „Testen“ klicken.
Das Passwort liegt im GNOME-Schlüsselbund. Empfohlen ist ein eigener RutOS-Benutzer mit Leserechten.
Für die optionalen SIM-Aktionen im Menü (Einstellung „SIM-Aktionen im Menü anbieten“: SIM-Wechsel,
Standard-SIM, Datenlimit zurücksetzen)
braucht er zusätzlich Schreibrecht für die mobilen Einstellungen.

## Funktionsweise

- RutOS-REST-API: `POST /api/login` holt ein Token, `GET /api/modems/status` die Werte.
  Das Token wird kurz vor Ablauf oder nach einem 401 erneuert.
- Selbstsigniertes Zertifikat: Der SHA-256-Fingerprint wird beim ersten Kontakt gepinnt (TOFU).
  Ändert er sich, wird die Verbindung blockiert, bis er in den Einstellungen gelöscht wird.
- Ist der Router nicht erreichbar, wird das Abfrageintervall still verlängert (exponentieller Backoff bis 5 min).
- Bei mehreren Modems wird das erste mit Signal angezeigt.
- SIM wechseln (Untermenü, nach Bestätigung): `switch_sim` („nächste SIM“), notfalls mehrmals, bis die Ziel-SIM
  aktiv ist – auch über leere Slots hinweg. Die Standard-SIM bleibt unverändert.
- Die API meldet den Betreiber nur für die aktive SIM. Der zuletzt gesehene Betreiber jeder SIM wird gemerkt
  und in den SIM-Menüs angezeigt, z. B. `SIM 3 (eSIM 1, MEDIONmobile)`. Eine SIM, die noch nie aktiv war, zeigt keinen.
- Standard-SIM festlegen (eigenes Untermenü): ändert nur die Konfiguration, die aktive Verbindung bleibt.
- „Beenden“ im Menü deaktiviert die Erweiterung (bleibt auch nach Neuanmeldung aus).
  Wieder starten über den Starter „Teltonika Indicator“ in der App-Übersicht
  (führt `gnome-extensions enable …` aus, keine Neuanmeldung nötig).
- Datenlimit (Netzwerk → Mobil → Limits am Router): Das Popup zeigt Verbrauch/Limit der aktiven SIM und den nächsten
  automatischen Reset. In der Leiste erscheint ein Warnsymbol, gelb ab der Warnschwelle (Standard 80 %, einstellbar),
  rot bei ausgeschöpftem Limit, dazu je Stufe einmal eine Benachrichtigung. Das SIM-Wechsel-Menü zeigt den Verbrauch
  der anderen SIMs. „Datenlimit zurücksetzen …“ (nach Bestätigung) setzt den Zähler der aktiven SIM auf 0;
  es wird zusammen mit dem SIM-Wechsel freigeschaltet und braucht dasselbe Schreibrecht.
- Leere Slots lassen sich in den Einstellungen ausblenden, weil die API nicht meldet, ob ein Slot belegt ist.

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

## Lizenz

GPL-2.0-or-later, siehe [LICENSE](LICENSE).
