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
Bei einem selbstsignierten Zertifikat (RutOS-Standard) zeigt „Testen“ den SHA-256-Fingerprint
und pinnt ihn erst nach Bestätigung – vorher wird kein Passwort gesendet und die Erweiterung fragt nichts ab.
Das Passwort liegt im GNOME-Schlüsselbund. Empfohlen ist ein eigener RutOS-Benutzer mit Leserechten.
Für die optionalen SIM-Aktionen im Menü (Einstellung „SIM-Aktionen im Menü anbieten“: SIM-Wechsel,
Standard-SIM, Datenlimit zurücksetzen)
braucht er zusätzlich Schreibrecht für die mobilen Einstellungen.

## Funktionsweise

- RutOS-REST-API: `POST /api/login` holt ein Token, `GET /api/modems/status` die Werte.
  Das Token wird kurz vor Ablauf oder nach einem 401 erneuert.
- Immer HTTPS: Eine `http://`-Adresse wird auf `https://` umgestellt, Redirects werden nicht verfolgt.
- Selbstsigniertes Zertifikat: Der SHA-256-Fingerprint wird nur nach Bestätigung in den Einstellungen gepinnt.
  Ändert er sich, wird die Verbindung blockiert, bis das neue Zertifikat beim „Testen“ bestätigt wird.
  Eine neue Router-Adresse löscht den Pin. Zertifikate, denen das System vertraut, brauchen keinen Pin.
- Ist der Router nicht erreichbar, wird das Abfrageintervall still verlängert (exponentieller Backoff bis 5 min).
  Bei falschem Passwort oder Zertifikatsproblemen hält die Abfrage an (eine Benachrichtigung), bis die
  Einstellungen geändert werden – so löst sie keine Brute-Force-Sperre des Routers aus.
- Antworten des Routers sind auf 1 MiB und 30 s je Anfrage begrenzt.
- Bei mehreren Modems wird das erste mit Signal angezeigt; ein SIM-Wechsel betrifft immer das gewählte Modem.
- SIM wechseln (Untermenü, nach Bestätigung): `switch_sim` („nächste SIM“), notfalls mehrmals, bis die Ziel-SIM
  aktiv ist – auch über leere Slots hinweg. Die Standard-SIM bleibt unverändert.
- Die API meldet den Betreiber nur für die aktive SIM. Der zuletzt gesehene Betreiber jeder SIM wird gemerkt
  und in den SIM-Menüs angezeigt, z. B. `SIM 3 (eSIM 1, MEDIONmobile)`. Eine SIM, die noch nie aktiv war, zeigt keinen.
- Standard-SIM festlegen (eigenes Untermenü): ändert nur die Konfiguration, die aktive Verbindung bleibt.
- „Router neu starten …“ (Einstellung „Router neu starten im Menü anbieten“, nach Bestätigung):
  `POST /api/system/actions/reboot`. Braucht Schreibrecht für System → Administration. Die nächste Abfrage
  kommt nach 60 s, danach greift der normale Backoff. Ausschalten lässt sich der Router über die API nicht.
- „Erweiterung deaktivieren“ im Menü schaltet die Erweiterung aus (bleibt auch nach Neuanmeldung aus).
  Wieder einschalten über die App „Erweiterungen“ oder – bei Installation per `make install` – über den
  Starter „Teltonika Indicator“ in der App-Übersicht (führt `gnome-extensions enable …` aus).
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
