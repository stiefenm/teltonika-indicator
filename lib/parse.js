// Reine Funktionen: RutOS-Antworten normalisieren und formatieren.
// Keine Shell-/GTK-Imports, damit sie in gjs-Tests und in prefs.js laufen.

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

// "−95 dBm", "-95", -95 → -95; alles andere → null
export function num(v) {
    if (v === null || v === undefined)
        return null;
    if (typeof v === 'number')
        return Number.isFinite(v) ? v : null;
    const m = String(v).replace('−', '-').match(/-?\d+(\.\d+)?/);
    return m ? parseFloat(m[0]) : null;
}

export function normalizeBaseUrl(host) {
    let h = (host ?? '').trim();
    if (!h)
        return null;
    if (!/^https?:\/\//i.test(h))
        h = `https://${h}`;
    return h.replace(/\/+$/, '');
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
    return ca.map(c => shortBand(pick(c, 'band', 'bandwidth_band', 'name'))).filter(Boolean);
}

function temperatureOf(v) {
    const t = num(v);
    if (t === null)
        return null;
    // Manche Firmware liefert Zehntelgrad (z. B. 390 = 39,0 °C)
    return Math.abs(t) > 150 ? t / 10 : t;
}

export function normalizeModem(raw) {
    const conntype = pick(raw, 'conntype', 'ntype', 'net_mode', 'service');
    const band = pick(raw, 'band', 'active_band');
    const bands = [shortBand(band), ...caBands(raw)]
        .filter((b, i, a) => b && a.indexOf(b) === i);
    return {
        id: pick(raw, 'id', 'modem_id') ?? '',
        name: pick(raw, 'name', 'model') ?? '',
        model: pick(raw, 'model'),
        operator: pick(raw, 'operator', 'provider', 'oper'),
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
        simState: pick(raw, 'simstate', 'sim_state'),
        state: pick(raw, 'state', 'netstate', 'operator_state'),
        activeSim: num(pick(raw, 'active_sim', 'sim')),
        simCount: num(pick(raw, 'sim_count')),
        esimProfile: pick(raw, 'esim_profile'),
        offline: raw.offline === true,
        txBytes: num(pick(raw, 'txbytes', 'tx_bytes')),
        rxBytes: num(pick(raw, 'rxbytes', 'rx_bytes')),
    };
}

// Antwort von GET /api/modems/status → normalisierte Modems
export function parseModems(json) {
    if (!json || json.success === false)
        throw new Error('Ungültige Antwort von modems/status');
    let data = json.data ?? json;
    if (!Array.isArray(data))
        data = [data];
    return data.filter(d => d && typeof d === 'object').map(normalizeModem);
}

// GET /api/sim_cards/status → SIM-Steckplätze/eSIM-Profile
export function parseSimCards(json) {
    const data = Array.isArray(json?.data) ? json.data : [];
    return data.filter(d => d && (d.section_name || d.id)).map(d => ({
        id: d.section_name ?? d.id,
        modem: d.modem ?? null,
        position: num(d.sim ?? d.position),
        esimProfile: pick(d, 'esim_profile'),
        primary: d.primary === '1' || d.primary === true,
    }));
}

export function simLabel(card) {
    if (!card)
        return '';
    return card.esimProfile
        ? `SIM ${card.position} (eSIM ${card.esimProfile})`
        : `SIM ${card.position}`;
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
    return modems.find(m => m.netType && (m.rsrp !== null || m.rssi !== null)) ?? modems[0];
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
