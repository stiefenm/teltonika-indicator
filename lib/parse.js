// Reine Funktionen: RutOS-Antworten normalisieren und formatieren.
// Keine Shell-/GTK-Imports, damit sie in gjs-Tests und in prefs.js laufen.

import {_} from './i18n.js';

// Erstes nicht-leeres Feld aus mehreren Kandidaten (Feldnamen variieren je Firmware).
export function pick(obj, ...keys) {
    if (!obj)
        return null;
    for (const k of keys) {
        const v = obj[k];
        if (v !== undefined && v !== null && v !== '' && v !== 'N/A')
            return v;
    }
    return null;
}

// Text für Labels: nur Strings/Zahlen, gekürzt; Objekte o. Ä. → null (kaputte/bösartige Antworten)
const MAX_TEXT = 64;
export function text(v, max = MAX_TEXT) {
    if (typeof v !== 'string' && typeof v !== 'number')
        return null;
    const t = String(v).trim();
    return t ? t.slice(0, max) : null;
}

// "−95 dBm", "-95", -95 → -95; alles andere → null
export function num(v) {
    if (v === null || v === undefined)
        return null;
    if (typeof v === 'number')
        return Number.isFinite(v) ? v : null;
    const m = String(v).replace('−', '-').match(/-?\d+(\.\d+)?/);
    return m ? parseFloat(m[0]) : null;
}

// Immer HTTPS: das Passwort darf nicht im Klartext durchs LAN. http:// bleibt nur
// für Loopback (Tests, lokale Tunnel) erhalten.
export function normalizeBaseUrl(host) {
    let h = (host ?? '').trim().replace(/\/+$/, '');
    if (!h)
        return null;
    const m = h.match(/^(https?):\/\/(.*)$/i);
    const rest = m ? m[2] : h;
    const loopback = /^(127\.\d+\.\d+\.\d+|localhost|\[::1\])(:\d+)?(\/|$)/i.test(rest);
    const scheme = m?.[1].toLowerCase() === 'http' && loopback ? 'http' : 'https';
    return `${scheme}://${rest}`;
}

export function netTypeOf(conntype) {
    const c = String(conntype ?? '').toUpperCase();
    if (!c)
        return null;
    if (c.includes('5G') || c.includes('NR'))
        return '5G';
    if (c.includes('LTE') || c.includes('4G'))
        return '4G';
    if (/WCDMA|UMTS|HSPA|HSDPA|HSUPA|3G/.test(c))
        return '3G';
    if (/GSM|EDGE|GPRS|2G/.test(c))
        return '2G';
    return null;
}

// "LTE B3", "LTE_B3", "B3", "LTE BAND 3", "5G N78" → "B3" / "n78"
export function shortBand(band) {
    const b = String(band ?? '').trim();
    if (!b)
        return null;
    const u = b.toUpperCase();
    const is5g = /5G|NR|(^|[^A-Z])N\d/.test(u);
    const isLte = /LTE|4G|BAND|(^|[^A-Z])B\d/.test(u);
    if (!is5g && !isLte)
        return b; // z. B. "WCDMA 2100" unverändert
    const digits = u.replace(/[2345]G/g, ' ').match(/\d+/g);
    if (!digits)
        return b;
    return `${is5g ? 'n' : 'B'}${digits[digits.length - 1]}`;
}

function caBands(modem) {
    const ca = pick(modem, 'ca_signal', 'ca', 'carrier_aggregation');
    if (!Array.isArray(ca))
        return [];
    return ca.map(c => shortBand(text(pick(c, 'band', 'bandwidth_band', 'name')))).filter(Boolean);
}

function temperatureOf(v) {
    const t = num(v);
    if (t === null)
        return null;
    // Manche Firmware liefert Zehntelgrad (z. B. 390 = 39,0 °C)
    return Math.abs(t) > 150 ? t / 10 : t;
}

export function normalizeModem(raw) {
    const conntype = text(pick(raw, 'conntype', 'ntype', 'net_mode', 'service'));
    const band = text(pick(raw, 'band', 'active_band'));
    const bands = [shortBand(band), ...caBands(raw)]
        .filter((b, i, a) => b && a.indexOf(b) === i);
    return {
        id: text(pick(raw, 'id', 'modem_id')) ?? '',
        name: text(pick(raw, 'name', 'model')) ?? '',
        model: text(pick(raw, 'model')),
        operator: text(pick(raw, 'operator', 'provider', 'oper')),
        conntype,
        netType: netTypeOf(conntype),
        band,
        bands,
        bandShort: bands.join('+') || null,
        rssi: num(pick(raw, 'rssi', 'signal')),
        rsrp: num(pick(raw, 'rsrp')),
        rsrq: num(pick(raw, 'rsrq')),
        sinr: num(pick(raw, 'sinr')),
        temperature: temperatureOf(pick(raw, 'temperature', 'temp')),
        simState: text(pick(raw, 'simstate', 'sim_state')),
        state: text(pick(raw, 'state', 'netstate', 'operator_state')),
        activeSim: num(pick(raw, 'active_sim', 'sim')),
        simCount: num(pick(raw, 'sim_count')),
        esimProfile: text(pick(raw, 'esim_profile')),
        offline: raw.offline === true,
        txBytes: num(pick(raw, 'txbytes', 'tx_bytes')),
        rxBytes: num(pick(raw, 'rxbytes', 'rx_bytes')),
    };
}

// Antwort von GET /api/modems/status → normalisierte Modems
export function parseModems(json) {
    if (!json || json.success === false)
        throw new Error(_('Invalid response from modems/status'));
    let data = json.data ?? json;
    if (!Array.isArray(data))
        data = [data];
    return data.filter(d => d && typeof d === 'object').map(normalizeModem);
}

// GET /api/sim_cards/status → SIM-Steckplätze/eSIM-Profile
export function parseSimCards(json) {
    const data = Array.isArray(json?.data) ? json.data : [];
    return data.filter(d => d && (d.section_name || d.id)).map(d => ({
        id: text(d.section_name ?? d.id),
        modem: text(d.modem),
        position: num(d.sim ?? d.position),
        esimProfile: text(pick(d, 'esim_profile')),
        primary: d.primary === '1' || d.primary === true,
    }));
}

// Zuletzt gesehener Betreiber (card.operator) in Klammern, z. B. „SIM 3 (eSIM 1, MEDIONmobile)“
export function simLabel(card) {
    if (!card)
        return '';
    const extra = [card.esimProfile ? `eSIM ${card.esimProfile}` : null, card.operator].filter(Boolean);
    return extra.length ? `SIM ${card.position} (${extra.join(', ')})` : `SIM ${card.position}`;
}

// Schlüssel für den gemerkten Betreiber je SIM (Slot + eSIM-Profil)
export function simKey(position, esimProfile) {
    return `${position}/${esimProfile ?? ''}`;
}

// Wie die RutOS-WebUI: Slot muss passen, bei eSIM zusätzlich das Profil
export function isActiveSim(modem, card) {
    if (!modem || !card || modem.activeSim !== card.position)
        return false;
    return !card.esimProfile || String(modem.esimProfile) === String(card.esimProfile);
}

// Modem mit tatsächlicher Verbindung bevorzugen
export function primaryModem(modems) {
    if (!modems.length)
        return null;
    return modems.find(m => m.netType && (m.rsrp !== null || m.rssi !== null)) ??
        modems.find(m => !m.offline) ?? modems[0];
}

// 0 (kein) … 4 (exzellent), -1 = unbekannt
export function signalQuality(m) {
    if (!m)
        return -1;
    const steps = (v, t) => t.filter(x => v >= x).length;
    if (m.rsrp !== null)
        return steps(m.rsrp, [-110, -100, -90, -80]);
    if (m.rssi !== null)
        return steps(m.rssi, [-95, -85, -75, -65]);
    return -1;
}

export const METRIC_UNITS = {rsrp: 'dBm', rssi: 'dBm', rsrq: 'dB', sinr: 'dB'};

export function formatMetric(value, metric) {
    if (value === null || value === undefined)
        return '–';
    const s = String(Math.round(value * 10) / 10).replace('-', '−');
    return `${s} ${METRIC_UNITS[metric] ?? ''}`.trim();
}

export function formatLabel(m, opts = {}) {
    if (!m)
        return '';
    const {showNetType = true, showBand = true, showSignal = true,
        showOperator = false, metric = 'rsrp'} = opts;
    const parts = [];
    if (showOperator && m.operator)
        parts.push(m.operator);
    if (showNetType && m.netType)
        parts.push(m.netType);
    if (showBand && m.bandShort)
        parts.push(m.bandShort);
    if (showSignal) {
        // Fallback auf RSSI, falls die gewählte Metrik fehlt (z. B. 3G ohne RSRP)
        const val = m[metric] ?? m.rssi;
        const used = m[metric] !== null ? metric : 'rssi';
        if (val !== null)
            parts.push(formatMetric(val, used));
    }
    return parts.join(' ');
}

export function formatBytes(n) {
    if (n === null || n === undefined)
        return '–';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    while (n >= 1024 && i < units.length - 1) {
        n /= 1024;
        i++;
    }
    return `${n.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

// GET /api/interfaces/config → Mobil-Interface → {modem, position, esimProfile}.
// Der Name allein reicht nicht: „mob1s3a1e2“ ist eSIM-Profil 1 (e2 ist interner Zähler).
export function parseMobileInterfaces(json) {
    const map = {};
    for (const d of Array.isArray(json?.data) ? json.data : []) {
        if (d?.id && d.sim !== undefined)
            map[d.id] = {modem: text(d.modem), position: num(d.sim), esimProfile: text(pick(d, 'esim_profile'))};
    }
    return map;
}

// Unix-Zeit zwischen 1970 und 2100, sonst null (GLib.DateTime würde werfen)
function plausibleTime(t) {
    return t !== null && t > 0 && t < 4102444800 ? Math.floor(t) : null;
}

// GET /api/data_limit/status → Datenlimits je Mobil-Interface (Bytes, due = Unix-Zeit des Auto-Resets)
export function parseDataLimits(json, interfaces = {}) {
    const data = Array.isArray(json?.data) ? json.data : [];
    return data.filter(d => d?.id).map(d => {
        const iface = String(d.interface ?? d.id);
        // Ohne interfaces/config: Slot aus dem Namen, eSIM-Profil unbekannt
        const known = interfaces[iface] ?? {modem: null, position: num(iface.match(/s(\d+)a/)?.[1]), esimProfile: null};
        return {
            interface: iface,
            ...known,
            enabled: d.enabled === '1' && num(d.data_limit) > 0,
            used: num(d.data_used) ?? 0,
            limit: num(d.data_limit),
            due: plausibleTime(num(d.due_reset_time)),
        };
    });
}

// Limit zur SIM (Karte aus sim_cards oder {position, esimProfile} des Modems)
export function dataLimitFor(limits, modemId, sim) {
    if (!sim)
        return null;
    return limits.find(l => l.enabled && (!l.modem || !modemId || l.modem === modemId) &&
        l.position === sim.position &&
        (!l.esimProfile || !sim.esimProfile || String(l.esimProfile) === String(sim.esimProfile))) ?? null;
}

export function dataLimitPercent(l) {
    return l?.enabled ? Math.floor(l.used / l.limit * 100) : null;
}

// 0 = ok, 1 = Warnschwelle erreicht, 2 = ausgeschöpft; warnPercent 0 = keine Warnung
export function dataLimitLevel(l, warnPercent = 80) {
    const p = dataLimitPercent(l);
    if (p === null)
        return 0;
    if (l.used >= l.limit)
        return 2;
    return warnPercent > 0 && p >= warnPercent ? 1 : 0;
}

export function formatDataLimit(l) {
    if (!l?.enabled)
        return null;
    return `${formatBytes(l.used)} / ${formatBytes(l.limit)} (${dataLimitPercent(l)} %)`;
}
