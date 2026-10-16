// RutOS-REST-Client (Soup 3): Login mit Token-Refresh, TOFU-Zertifikats-Pinning.
// Wird von extension.js und prefs.js genutzt, keine Shell-Imports.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';

import {normalizeBaseUrl, parseModems, parseSimCards} from './parse.js';

Gio._promisify(Soup.Session.prototype, 'send_and_read_async');

// Kind: 'config' | 'auth' | 'forbidden' | 'cert' | 'network' | 'http' | 'parse' | 'cancelled'
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
     * @param {string} [p.fingerprint] - gepinnter SHA-256-Fingerprint
     * @param {(fp: string) => void} [p.onFingerprint] - erster Kontakt (TOFU)
     * @param {number} [p.timeout] - Sekunden
     */
    constructor({host, username, getPassword, fingerprint = '', onFingerprint = null, timeout = 10}) {
        this._baseUrl = normalizeBaseUrl(host);
        this._username = username;
        this._getPassword = getPassword;
        this._fingerprint = fingerprint;
        this._onFingerprint = onFingerprint;
        this._token = null;
        this._tokenExpiry = 0;
        this._session = new Soup.Session({timeout, user_agent: 'teltonika-indicator'});
        this._decoder = new TextDecoder();
        this._encoder = new TextEncoder();
    }

    get baseUrl() {
        return this._baseUrl;
    }

    get fingerprint() {
        return this._fingerprint;
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
        // Nur bei nicht vertrauenswürdigem Zertifikat aufgerufen (selbstsigniert)
        msg.connect('accept-certificate', (_msg, cert) => {
            const fp = certFingerprint(cert);
            if (!this._fingerprint) {
                this._fingerprint = fp;
                this._onFingerprint?.(fp);
                return true;
            }
            if (fp === this._fingerprint)
                return true;
            this._certMismatch = fp;
            return false;
        });
        return msg;
    }

    async _send(msg, cancellable) {
        if (!this._session)
            throw new ApiError('cancelled', 'Client beendet');
        this._certMismatch = null;
        let bytes;
        try {
            bytes = await this._session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, cancellable);
        } catch (e) {
            if (this._certMismatch) {
                throw new ApiError('cert', 'Zertifikat des Routers hat sich geändert',
                    {fingerprint: this._certMismatch});
            }
            if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                throw new ApiError('cancelled', 'Abgebrochen');
            throw new ApiError('network', e.message);
        }
        const status = msg.get_status();
        const text = this._decoder.decode(bytes?.get_data() ?? new Uint8Array());
        let json = null;
        try {
            json = text ? JSON.parse(text) : null;
        } catch {
            if (status >= 200 && status < 300)
                throw new ApiError('parse', 'Antwort ist kein JSON');
        }
        return {status, json};
    }

    async _login(cancellable) {
        if (!this._baseUrl)
            throw new ApiError('config', 'Keine Router-Adresse konfiguriert');
        let password;
        try {
            password = await this._getPassword();
        } catch (e) {
            throw new ApiError('config', `Schlüsselbund nicht verfügbar: ${e.message}`);
        }
        if (!password)
            throw new ApiError('config', 'Kein Passwort hinterlegt');

        const msg = this._newMessage('POST', '/login');
        const body = this._encoder.encode(JSON.stringify({username: this._username, password}));
        msg.set_request_body_from_bytes('application/json', new GLib.Bytes(body));
        const {status, json} = await this._send(msg, cancellable);

        const token = json?.data?.token ?? json?.token;
        if (status === 401 || status === 403 || json?.success === false || !token) {
            const detail = json?.errors?.[0]?.error ?? `HTTP ${status}`;
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
                const detail = json?.errors?.[0]?.error;
                throw new ApiError('forbidden',
                    `Keine Berechtigung für ${method} ${path}${detail ? ` (${detail})` : ''}`);
            }
            if (status < 200 || status >= 300 || json?.success === false) {
                const detail = json?.errors?.[0]?.error ?? `HTTP ${status}`;
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

    // Gezielter SIM-Wechsel wie in der RutOS-WebUI: Ziel-SIM als Standard setzen,
    // dann Verbindung neu aufbauen (kommt mit der Standard-SIM zurück).
    // Braucht Schreibrecht für die mobilen Einstellungen.
    async activateSim(modemId, simCardId, cancellable = null) {
        await this.request('PUT', `/sim_cards/config/${encodeURIComponent(simCardId)}`,
            {data: {primary: '1'}}, cancellable);
        await this.request('POST', `/modems/${encodeURIComponent(modemId)}/actions/restart_connection`,
            null, cancellable);
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
