# Projekt-Brief: Teltonika Router Indicator für GNOME

Stand: 2026-10-16 · Grundlage für Planung (GSD: Meilensteine/Phasen)

## Ziel

Eine GNOME-Shell-Erweiterung, die den Status eines Teltonika-Routers (RUT/RUTX, RutOS 7.x)
live in der oberen Leiste zeigt – analog zu „Vitals“ für CPU/RAM.

Beispiel Panel-Label: `5G B3 −95 dBm` (Icon farbcodiert nach Signalqualität)
Popup: Betreiber, Netztyp, Band, RSSI/RSRP/RSRQ/SINR, WAN-Status, Datenverbrauch,
verbundene Clients, Modemtemperatur, ggf. GPS.

## Zielumgebung

- Ubuntu 26.04 LTS, GNOME Shell 50 (Wayland-only)
- ESM-Extension (GNOME 45+), `shell-version` z. B. `["48","49","50"]`
- Router: Teltonika mit RutOS 7.x (REST-API unter `/api/`)

## Marktlage

- Kein Teltonika-Tool für den Desktop (extensions.gnome.org: 0 Treffer, GitHub: nichts).
- Server-seitig abgedeckt: Home Assistant (offizielle Integration seit 2026.3),
  Python-Lib `teltasync`, `pytonika`, Prometheus `kozaktomas/teltonika-exporter`.
- UI-Vorbilder: Vitals, „Huawei MIFI Status Indicator“ (EGO 1103),
  „Fritzbox Uplink Monitor“ (EGO 1016).

## Datenzugriff (Entscheidung: RutOS REST-API)

| Quelle | Bewertung |
|---|---|
| REST `/api/` (RutOS 7.x) | **Primär.** `POST /api/login {username,password}` → JWT (`expires` ~299 s), Header `Authorization: Bearer …`. `GET /api/modems/status` liefert rssi, rsrp, rsrq, sinr, operator, conntype, band, temperature, simstate, txbytes/rxbytes. Weitere Endpunkte: System, Data Usage, DHCP/Wireless-Clients, GPS. |
| ubus JSON-RPC | Vermeiden – instabile Ausgaben seit 7.13/7.17, ab 7.18 extra Paket nötig. |
| SNMP (OID 1.3.6.1.4.1.48690) | Später evtl. Fallback. |
| SSH + `gsmctl -E` | Später evtl. Fallback für Power-User. |

Doku pro Modell/Firmware: https://developers.teltonika-networks.com/
(JS-gerendert → Feldnamen am echten Gerät mit `curl -k` verifizieren!)

## Technische Eckpunkte

- HTTP: Soup 3 (`Soup.Session`, `send_and_read_async`)
- Selbstsigniertes Zertifikat: TOFU – Fingerprint beim ersten Verbinden speichern und pinnen;
  optional HTTP im LAN.
- Credentials: libsecret (`Secret.password_store/lookup`); Settings: GSettings;
  Prefs: Adw/GTK4.
- Token-Handling: Re-Login bei 401 oder kurz vor Ablauf.
- Polling 10–30 s konfigurierbar; bei Nichterreichbarkeit (Laptop nicht im LAN)
  leise in Backoff, kein Fehler-Spam.
- Mehrere Modems/SIMs: `modems/status` liefert Array.
- 5G NSA: NR-Träger nur in Carrier-Aggregation-Daten.
- EGO-Review-Regeln: alles in `enable()`/`disable()` sauber auf- und abbauen,
  nichts zur Importzeit.
- Empfehlung an Nutzer: eigener Read-only-User in RutOS.

## Scope-Vorschlag

**MVP (v0.1):** ein Router, Login + Token-Refresh, Panel-Label (Netztyp/Band/Signal),
Popup mit Detailwerten, Prefs (Host, User, Passwort via libsecret, Intervall),
Cert-Pinning, Offline-Backoff.

**v1.0:** Datenverbrauch, Clients, WAN-Status, Schwellwert-Notifications,
Auswahl angezeigter Werte, Multi-Modem/Dual-SIM, i18n (de/en), Veröffentlichung auf EGO.

**Später/optional:** Quick-Settings-Tile, Signalverlauf (Sparkline) zur Antennenausrichtung,
Waybar-JSON-CLI, GPS-Anzeige, SNMP/SSH-Fallback, mehrere Router.

## Vorschlag Meilensteine & Phasen (Entwurf für GSD)

**Meilenstein 1 – MVP (v0.1)**

1. **API-Spike am echten Router** – Login, `modems/status` u. a. per `curl -k` abfragen,
   echte Antworten als Fixtures (`test/fixtures/*.json`) ablegen, Feldnamen festhalten.
2. **API-Client-Layer (GJS)** – Soup 3, Login/Token-Refresh, TOFU-Cert-Pinning,
   Fehler-/Offline-Backoff; testbar gegen Fixtures.
3. **Panel-Indicator & Popup** – `PanelMenu.Button` mit Label/Icon (Signalqualität farbcodiert),
   Popup mit Detailwerten, sauberes `enable()`/`disable()`.
4. **Preferences & Credentials** – Adw-Prefs (Host, User, Intervall, angezeigte Werte),
   Passwort via libsecret, GSettings-Schema.

**Meilenstein 2 – v1.0**

5. **Mehr Daten** – Datenverbrauch, Clients, WAN-Status, Multi-Modem/Dual-SIM.
6. **Notifications** – Schwellwerte (z. B. Signal schlecht, WAN down, Datenlimit).
7. **Release** – i18n (de/en), Lizenz, README/Screenshots, EGO-Upload & Review.

**Backlog:** Quick-Settings-Tile, Signal-Sparkline (Antennenausrichtung), Waybar-CLI,
GPS, SNMP/SSH-Fallback, mehrere Router.

## Aufwandsschätzung

- MVP: 2–4 Tage
- v1.0 inkl. EGO-Freigabe: 2–3 Wochen

## Offene Fragen

- Welches Router-Modell / welche Firmware ist im Einsatz (Testgerät)?
- Zugriff nur im LAN oder auch über VPN/RMS?
- Veröffentlichung auf extensions.gnome.org gewünscht?
- Lizenz (Vorschlag: GPL-2.0-or-later, üblich für GNOME-Extensions)
