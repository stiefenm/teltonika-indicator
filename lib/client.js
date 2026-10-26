// RutOS-REST-Client (Soup 3): Login mit Token-Refresh, Zertifikats-Pinning.
// Wird von extension.js und prefs.js genutzt, keine Shell-Imports.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';

import {normalizeBaseUrl, parseDataLimits, parseMobileInterfaces, parseModems, parseSimCards} from './parse.js';

Gio._promisify(Soup.Session.prototype, 'send_async');
Gio._promisify(Gio.InputStream.prototype, 'read_bytes_async');
Gio._promisify(Gio.InputStream.prototype, 'close_async');

// Kind: 'config' | 'password' | 'auth' | 'forbidden' | 'untrusted' | 'cert' | 'network' | 'http' | 'parse' | 'cancelled'
// untrusted: Zertifikat ist weder systemweit vertrauenswürdig noch gepinnt (Fingerprint in .fingerprint)
// cert: gepinntes Zertifikat hat sich geändert
export class ApiError extends Error {
    constructor(kind, message, extra = {}) {
        super(message);
        this.name = 'ApiError';
        this.kind = kind;
        Object.assign(this, extra);
    }
}

// Token kurz vor Ablauf erneuern
const TOKEN_MARGIN_S = 20;
// Schutz gegen kaputte oder bösartige Antworten: Größe und Gesamtdauer begrenzen
const MAX_RESPONSE_BYTES = 1024 * 1024;
const READ_CHUNK = 64 * 1024;
const MAX_ERROR_TEXT = 200;

// Fehlertext des Routers, gekürzt (landet in Statuszeile und Benachrichtigungen)
function routerError(json, fallback) {
    const e = json?.errors?.[0]?.error;
    return e ? String(e).slice(0, MAX_ERROR_TEXT) : fallback;
}

export function certFingerprint(cert) {
    const der = cert.certificate; // GByteArray → Uint8Array
    const hex = GLib.compute_checksum_for_data(GLib.ChecksumType.SHA256, der);
    return hex.toUpperCase().match(/../g).join(':');
}

export class RouterClient {
    /**
     * @param {object} p
     * @param {string} p.host - Router-Adresse (mit/ohne Schema)
     * @param {string} p.username
     * @param {() => Promise<string|null>} p.getPassword
     * @param {string} [p.fingerprint] - gepinnter SHA-256-Fingerprint (für selbstsignierte Zertifikate)
     * @param {number} [p.timeout] - Sekunden ohne Fortschritt je I/O-Schritt
     * @param {number} [p.maxTime] - Sekunden je Anfrage insgesamt
     */
    constructor({host, username, getPassword, fingerprint = '', timeout = 10, maxTime = 30}) {
        this._baseUrl = normalizeBaseUrl(host);
        this._username = username;
        this._getPassword = getPassword;
        this._fingerprint = fingerprint;
        this._maxTime = maxTime;
        this._token = null;
        this._tokenExpiry = 0;
        this._interfaces = null; // Mobil-Interfaces aus interfaces/config, selten geändert
        this._session = new Soup.Session({timeout, user_agent: 'teltonika-indicator'});
        this._decoder = new TextDecoder();
        this._encoder = new TextEncoder();
    }

    get baseUrl() {
        return this._baseUrl;
    }

    destroy() {
        this._session?.abort();
        this._session = null;
        this._token = null;
    }

    _newMessage(method, path) {
        const msg = Soup.Message.new(method, `${this._baseUrl}/api${path}`);
        if (!msg)
            throw new ApiError('config', `Ungültige Router-Adresse: ${this._baseUrl}`);
        // Redirects nie folgen: kein Wechsel auf HTTP oder fremde Hosts
        msg.set_flags(Soup.MessageFlags.NO_REDIRECT);
        // Nur bei nicht vertrauenswürdigem Zertifikat aufgerufen (selbstsigniert). Ohne Pin wird
        // abgelehnt, bevor etwas gesendet wird – bestätigt wird in den Einstellungen.
        msg.connect('accept-certificate', (_msg, cert) => {
            const fp = certFingerprint(cert);
            if (this._fingerprint && fp === this._fingerprint)
                return true;
            this._rejectedFp = fp;
            return false;
        });
        return msg;
    }

    async _send(msg, cancellable) {
        if (!this._session)
            throw new ApiError('cancelled', 'Client beendet');
        this._rejectedFp = null;
        // Session-Timeout gilt nur je I/O-Schritt; Gesamtdauer über eigenes Cancellable begrenzen
        const local = new Gio.Cancellable();
        // Gio.Cancellable.connect ist g_cancellable_connect (nur Callback, ruft ihn sofort auf,
        // falls schon abgebrochen) – nicht GObject.connect('cancelled', …)
        const outerId = cancellable?.connect(() => local.cancel()) ?? 0;
        let timedOut = false;
        let timerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, this._maxTime, () => {
            timerId = 0;
            timedOut = true;
            local.cancel();
            return GLib.SOURCE_REMOVE;
        });
        let data;
        try {
            const stream = await this._session.send_async(msg, GLib.PRIORITY_DEFAULT, local);
            data = await this._readAll(msg, stream, local);
        } catch (e) {
            if (e instanceof ApiError)
                throw e;
            if (this._rejectedFp) {
                throw this._fingerprint
                    ? new ApiError('cert', 'Zertifikat des Routers hat sich geändert', {fingerprint: this._rejectedFp})
                    : new ApiError('untrusted', 'Zertifikat des Routers noch nicht bestätigt',
                        {fingerprint: this._rejectedFp});
            }
            if (timedOut)
                throw new ApiError('network', 'Zeitüberschreitung');
            if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                throw new ApiError('cancelled', 'Abgebrochen');
            throw new ApiError('network', e.message);
        } finally {
            if (timerId)
                GLib.source_remove(timerId);
            if (outerId)
                cancellable.disconnect(outerId);
        }
        const status = msg.get_status();
        if (status >= 300 && status < 400)
            throw new ApiError('config', `Router leitet um (HTTP ${status}) – Adresse prüfen`);
        const text = this._decoder.decode(data);
        let json = null;
        try {
            json = text ? JSON.parse(text) : null;
        } catch {
            if (status >= 200 && status < 300)
                throw new ApiError('parse', 'Antwort ist kein JSON');
        }
        return {status, json};
    }

    // Antwort bis MAX_RESPONSE_BYTES lesen, größere abbrechen
    async _readAll(msg, stream, cancellable) {
        const tooBig = () => new ApiError('parse', 'Antwort des Routers zu groß');
        try {
            if (msg.get_response_headers().get_content_length() > MAX_RESPONSE_BYTES)
                throw tooBig();
            const chunks = [];
            let total = 0;
            for (;;) {
                const bytes = await stream.read_bytes_async(READ_CHUNK, GLib.PRIORITY_DEFAULT, cancellable);
                const size = bytes.get_size();
                if (!size)
                    break;
                total += size;
                if (total > MAX_RESPONSE_BYTES)
                    throw tooBig();
                chunks.push(bytes.toArray());
            }
            const data = new Uint8Array(total);
            let offset = 0;
            for (const c of chunks) {
                data.set(c, offset);
                offset += c.length;
            }
            return data;
        } finally {
            stream.close_async(GLib.PRIORITY_DEFAULT, null).catch(() => {});
        }
    }

    async _login(cancellable) {
        if (!this._baseUrl)
            throw new ApiError('config', 'Keine Router-Adresse konfiguriert');
        let password;
        try {
            password = await this._getPassword();
        } catch (e) {
            throw new ApiError('password', `Schlüsselbund nicht verfügbar: ${e.message}`);
        }
        if (!password)
            throw new ApiError('password', 'Kein Passwort hinterlegt');

        const msg = this._newMessage('POST', '/login');
        const body = this._encoder.encode(JSON.stringify({username: this._username, password}));
        msg.set_request_body_from_bytes('application/json', new GLib.Bytes(body));
        const {status, json} = await this._send(msg, cancellable);

        const token = json?.data?.token ?? json?.token;
        if (status === 401 || status === 403 || json?.success === false || !token) {
            const detail = routerError(json, `HTTP ${status}`);
            throw new ApiError(status >= 500 ? 'http' : 'auth', `Login fehlgeschlagen: ${detail}`);
        }
        const expires = Number(json?.data?.expires ?? json?.expires ?? 299);
        this._token = token;
        this._tokenExpiry = GLib.get_monotonic_time() / 1e6 + expires - TOKEN_MARGIN_S;
    }

    _tokenValid() {
        return this._token && GLib.get_monotonic_time() / 1e6 < this._tokenExpiry;
    }

    async request(method, path, body = null, cancellable = null) {
        for (let attempt = 0; attempt < 2; attempt++) {
            if (!this._tokenValid())
                await this._login(cancellable);
            const msg = this._newMessage(method, path);
            msg.get_request_headers().append('Authorization', `Bearer ${this._token}`);
            if (body !== null) {
                msg.set_request_body_from_bytes('application/json',
                    new GLib.Bytes(this._encoder.encode(JSON.stringify(body))));
            }
            const {status, json} = await this._send(msg, cancellable);
            if (status === 401 && attempt === 0) {
                this._token = null; // abgelaufen/ungültig → einmal neu einloggen
                continue;
            }
            // 401 trotz frischem Token oder 403: Benutzer fehlt das Recht (RutOS-ACL)
            if (status === 401 || status === 403) {
                const detail = routerError(json, null);
                throw new ApiError('forbidden',
                    `Keine Berechtigung für ${method} ${path}${detail ? ` (${detail})` : ''}`);
            }
            if (status < 200 || status >= 300 || json?.success === false) {
                const detail = routerError(json, `HTTP ${status}`);
                throw new ApiError('http', `${method} ${path}: ${detail}`);
            }
            return json;
        }
        throw new ApiError('auth', 'Login abgelehnt');
    }

    get(path, cancellable = null) {
        return this.request('GET', path, null, cancellable);
    }

    async getSimCards(cancellable = null) {
        return parseSimCards(await this.get('/sim_cards/status', cancellable));
    }

    // Standard-SIM setzen; löst allein keine Neuverbindung aus (am RUTM30 geprüft)
    async setDefaultSim(simCardId, cancellable = null) {
        await this.request('PUT', `/sim_cards/config/${encodeURIComponent(simCardId)}`,
            {data: {primary: '1'}}, cancellable);
    }

    // Wechselt zur nächsten SIM des Modems (auch auf leere Slots – Aufrufer schaltet ggf. weiter).
    // Braucht Schreibrecht für die mobilen Einstellungen.
    async switchSim(modemId, cancellable = null) {
        await this.request('POST', `/modems/${encodeURIComponent(modemId)}/actions/switch_sim`,
            null, cancellable);
    }

    // Startet den Router neu; danach gilt das Token nicht mehr.
    // Braucht Schreibrecht für System → Administration.
    async reboot(cancellable = null) {
        await this.request('POST', '/system/actions/reboot', null, cancellable);
        this._token = null;
    }

    // Datenlimits je SIM; interfaces/config nur neu laden, wenn ein unbekanntes Interface auftaucht
    async getDataLimits(cancellable = null) {
        const json = await this.get('/data_limit/status', cancellable);
        const ids = (json?.data ?? []).map(d => d?.interface ?? d?.id);
        if (!this._interfacesDenied && (!this._interfaces || ids.some(id => id && !this._interfaces[id]))) {
            try {
                this._interfaces = parseMobileInterfaces(await this.get('/interfaces/config', cancellable));
            } catch (e) {
                // Ohne Leserecht: Slot aus dem Interface-Namen (siehe parseDataLimits)
                if (e.kind !== 'forbidden')
                    throw e;
                this._interfacesDenied = true;
            }
        }
        return parseDataLimits(json, this._interfaces ?? {});
    }

    // Zähler des Datenlimits zurücksetzen – der Router erlaubt das nur für das aktive Interface
    async clearDataLimit(iface, cancellable = null) {
        await this.request('POST', '/data_limit/actions/clear', {data: {interface: iface}}, cancellable);
    }

    async getModems(cancellable = null) {
        const json = await this.get('/modems/status', cancellable);
        try {
            return parseModems(json);
        } catch (e) {
            throw new ApiError('parse', e.message);
        }
    }
}
