# RutOS-REST-API – Notizen für den RUTM30

Stand 2026-10-16. Quelle: Teltonikas OpenAPI-Spec 7.25.3 / API v1.17.3
(`https://developers.teltonika-networks.com/docs/7.25.3_v1.17.3.json`; der RUTM30 ist dort gelistet),
dazu die Fixtures aus `kozaktomas/teltonika-exporter` und `karlbeecken/teltasync`.
**Am echten Gerät noch nicht verifiziert** → `scripts/capture-fixtures.sh`.

## RUTM30

- 5G SA/NSA, LTE Cat 19 als Fallback, Dual-SIM + eSIM, kein bestätigtes GNSS
- Bänder: LTE 1/3/5/7/8/20/28/38/40/41/42/43, NR n1/3/5/7/8/20/28/38/40/41/77/78
- Firmware: RUTM_R_00.07.25.3 (neueste), 07.24.6 (stable)

## Authentifizierung

| | |
|---|---|
| Login | `POST /api/login` `{"username","password"}` → `{"success":true,"data":{"token","expires":299,…}}` |
| Falsche Daten | HTTP 401, `errors[0].code` 120/121 |
| Aufrufe | Header `Authorization: Bearer <token>`; abgelaufen → 401 (Code 120/123) |
| Laufzeit | Idle-Timeout `api_session_timeout`, Standard 300 s |
| Logout | `POST /api/logout` |
| Ohne Login | `GET /api/unauthorized/status` → Modell, Name, API-Version |

## `GET /api/modems/status`

`data` ist ein Array, ein Eintrag pro Modem.

- Text: `id`, `name`, `model`, `operator`, `conntype` („5G (NSA)“, „4G (LTE)“), `ntype` („5G-NSA“, „LTE“),
  `band` („LTE B3“, „5G N78“), `netstate`, `simstate`, `state`
- Zahlen: `rssi`, `rsrp` in dBm; `rsrq`, `sinr` in dB; `temperature` als Ganzzahl in °C;
  `txbytes`/`rxbytes` (kumuliert); `active_sim`; `signal_quality` in %
- `ca_signal[]`: `{band, bandwidth, rsrp, rsrq, sinr, primary}`. Der NR-Träger bei NSA steht nur hier.
- Jedes Feld kann `"N/A"` sein. Ein Offline-Modem liefert nur `{id, name, offline, …}`.
- Die oberen `rsrp`/`sinr` gehören zum LTE-Anker; die NR-Werte stehen in `cell_info[]`, Eintrag mit passender `nr-arfcn`.

## SIM-Wechsel

- `POST /api/modems/{id}/actions/switch_sim` (ohne Body) wechselt zur nächsten SIM und antwortet mit `{"success":true}`.
- Rechte: RutOS-ACLs sind pfadbasiert (`read[]`/`write[]` pro Gruppe, z. B. `admin/network/*`).
  Der Benutzer braucht Lesezugriff plus Schreibzugriff auf Netzwerk → Mobilfunk. Damit könnte er
  aber auch APN und andere Mobilfunk-Einstellungen ändern.
- Eigene Rechte abfragen: `GET /api/users/acls/options`. Die genauen ACL-Namen am RUTM30 noch prüfen.
- Status und Log: `GET /api/sim_switch/status`, `GET /api/sim_switch/log/{modem_id}`

## Weitere Endpunkte (für v1.0)

- `system/device/status` – Firmware, Modell
- `system/device/usage/status` – Uptime, Last, RAM
- `data_usage/{day|week|month|total}/modem/{id}/sim/{n}/status` – `[[ts, rx, tx], …]`
- `interfaces/status`, `failover/status` – WAN-Status
- `dhcp/leases/ipv4/status`, `wireless/interfaces/status` – Clients

## HTTPS

HTTP (80) und HTTPS (443) sind im LAN standardmäßig an, „Redirect to HTTPS“ ist aktiv.
Das Zertifikat ist selbstsigniert (`uhttpd.crt`), deshalb TOFU-Pinning.
