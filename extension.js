import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as Dialog from 'resource:///org/gnome/shell/ui/dialog.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as ModalDialog from 'resource:///org/gnome/shell/ui/modalDialog.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {RouterClient} from './lib/client.js';
import {lookupPassword} from './lib/secret.js';
import {
    dataLimitFor, dataLimitLevel, dataLimitPercent, formatBytes, formatDataLimit, formatLabel, formatMetric, isActiveSim,
    normalizeBaseUrl, primaryModem, signalQuality, simKey, simLabel,
} from './lib/parse.js';

const MAX_BACKOFF_S = 300;
// Nach einem SIM-Wechsel häufiger abfragen, bis die neue SIM gemeldet wird
const SIM_SWITCH_POLL_S = 5;
const now = () => GLib.get_monotonic_time() / 1e6;
// Je Schritt (switch_sim) auf die nächste SIM warten, bevor abgebrochen wird
const SIM_HOP_TIMEOUT_S = 90;
// Erste Abfrage nach einem Neustart des Routers, danach normaler Backoff
const REBOOT_WAIT_S = 60;

const QUALITY_ICONS = [
    'network-cellular-signal-none-symbolic',
    'network-cellular-signal-weak-symbolic',
    'network-cellular-signal-ok-symbolic',
    'network-cellular-signal-good-symbolic',
    'network-cellular-signal-excellent-symbolic',
];
const ICON_OFFLINE = 'network-cellular-offline-symbolic';
const ICON_ACQUIRING = 'network-cellular-acquiring-symbolic';
const LIMIT_CLASSES = ['', 'teltonika-limit-warn', 'teltonika-limit-full'];

// Diese Fehler halten die Abfrage an, bis sich die Einstellungen ändern. 'auth' auch, damit
// wiederholte Fehlversuche nicht die Brute-Force-Sperre des Routers auslösen.
const STOP_KINDS = ['config', 'auth', 'untrusted', 'cert'];
// Ohne diese Daten läuft die Statusanzeige weiter (ältere Firmware, fehlendes Leserecht)
const OPTIONAL_KINDS = ['forbidden', 'http', 'parse'];

const STATUS_TEXT = {
    config: 'Nicht konfiguriert',
    password: 'Kein Passwort verfügbar',
    auth: 'Anmeldung fehlgeschlagen',
    forbidden: 'Fehlende Berechtigung',
    untrusted: 'Zertifikat nicht bestätigt – in den Einstellungen „Testen“',
    cert: 'Zertifikat geändert – Verbindung blockiert',
    network: 'Router nicht erreichbar',
    http: 'Fehler vom Router',
    parse: 'Unerwartete Antwort',
};

const DETAIL_ROWS = [
    ['operator', 'Betreiber'],
    ['conntype', 'Netz'],
    ['band', 'Band'],
    ['rssi', 'RSSI'],
    ['rsrp', 'RSRP'],
    ['rsrq', 'RSRQ'],
    ['sinr', 'SINR'],
    ['sim', 'SIM'],
    ['temperature', 'Modem-Temperatur'],
    ['traffic', 'Daten ↑/↓'],
    ['datalimit', 'Datenlimit'],
    ['limitreset', 'Limit-Reset'],
];

const InfoRow = GObject.registerClass(
class InfoRow extends PopupMenu.PopupBaseMenuItem {
    _init(title) {
        super._init({reactive: false, can_focus: false});
        this.add_child(new St.Label({
            text: title,
            x_expand: true,
            style_class: 'teltonika-row-title',
            y_align: Clutter.ActorAlign.CENTER,
        }));
        this._value = new St.Label({
            text: '–',
            style_class: 'teltonika-row-value',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.add_child(this._value);
    }

    setValue(text) {
        this._value.text = text ?? '–';
    }

    setValueClass(cls) {
        for (const c of LIMIT_CLASSES.filter(Boolean))
            this._value.remove_style_class_name(c);
        if (cls)
            this._value.add_style_class_name(cls);
    }
});

const TeltonikaIndicator = GObject.registerClass(
class TeltonikaIndicator extends PanelMenu.Button {
    _init(ext) {
        super._init(0.5, 'Teltonika Router');
        this._ext = ext;
        this._settings = ext.getSettings();
        this._client = null;
        this._timeoutId = 0;
        this._failures = 0;
        this._busy = false;
        this._modem = null;
        this._modems = [];
        this._simCards = [];
        this._dataLimits = [];
        this._activeLimit = null;
        this._limitNotified = {}; // Interface → zuletzt gemeldete Stufe (1 = Warnung, 2 = ausgeschöpft)
        this._switching = null; // {modemId, target, hops, maxHops, lastKey, hopStarted} während eines SIM-Wechsels
        this._refreshPending = false; // Abfrage angefordert, während eine lief
        this._lastError = ''; // zuletzt geloggter Fehler, gegen Log-Spam
        this._warned = new Set(); // einmal geloggte Warnungen optionaler Endpunkte
        this._dialog = null;
        this._idleId = 0;
        this._cancellable = new Gio.Cancellable();

        const box = new St.BoxLayout({style_class: 'panel-status-menu-box'});
        this._icon = new St.Icon({icon_name: ICON_ACQUIRING, style_class: 'system-status-icon'});
        this._label = new St.Label({
            text: '',
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'teltonika-label',
        });
        // Datenlimit der aktiven SIM: gelb ab Warnschwelle, rot wenn ausgeschöpft
        this._limitIcon = new St.Icon({
            icon_name: 'dialog-warning-symbolic',
            style_class: 'system-status-icon',
            visible: false,
        });
        box.add_child(this._icon);
        box.add_child(this._limitIcon);
        box.add_child(this._label);
        this.add_child(box);

        this._buildMenu();

        this._settingsIds = ['host', 'username', 'cert-fingerprint', 'password-serial'].map(k =>
            this._settings.connect(`changed::${k}`, () => this._onConnectionSettingsChanged()));
        this._settingsIds.push(this._settings.connect('changed::refresh-interval', () => this._reschedule(0)));
        this._settingsIds.push(this._settings.connect('changed::allow-reboot', () => this._updateRebootItem()));
        for (const k of ['allow-sim-switch', 'hidden-sim-slots'])
            this._settingsIds.push(this._settings.connect(`changed::${k}`, () => this._reschedule(0)));
        for (const k of ['show-net-type', 'show-band', 'show-signal', 'show-operator', 'signal-metric'])
            this._settingsIds.push(this._settings.connect(`changed::${k}`, () => this._updateLabel()));
        this._settingsIds.push(this._settings.connect('changed::data-limit-warning', () => this._updateDataLimit()));

        this._reschedule(0);
    }

    _buildMenu() {
        this._statusItem = new PopupMenu.PopupMenuItem('', {reactive: false, can_focus: false});
        this._statusItem.label.style_class = 'teltonika-status';
        this.menu.addMenuItem(this._statusItem);

        this._rows = {};
        const section = new PopupMenu.PopupMenuSection();
        for (const [key, title] of DETAIL_ROWS) {
            this._rows[key] = new InfoRow(title);
            section.addMenuItem(this._rows[key]);
        }
        this.menu.addMenuItem(section);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this.menu.addAction('Jetzt aktualisieren', () => this._reschedule(0));
        this._simItem = new PopupMenu.PopupSubMenuMenuItem('SIM wechseln');
        this._simItem.visible = false;
        this._simKey = '';
        this.menu.addMenuItem(this._simItem);
        this._defaultItem = new PopupMenu.PopupSubMenuMenuItem('Standard-SIM');
        this._defaultItem.visible = false;
        this._defaultKey = '';
        this.menu.addMenuItem(this._defaultItem);
        this._clearLimitItem = this.menu.addAction('Datenlimit zurücksetzen …', () => this._confirmClearLimit());
        this._clearLimitItem.visible = false;
        this._rebootItem = this.menu.addAction('Router neu starten …', () => this._confirmReboot());
        this._updateRebootItem();
        this.menu.addAction('Router-Weboberfläche öffnen', () => {
            const url = normalizeBaseUrl(this._settings.get_string('host'));
            if (url)
                Gio.AppInfo.launch_default_for_uri(url, null);
        });
        this.menu.addAction('Einstellungen', () => this._ext.openPreferences());
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        // Deaktiviert die Erweiterung (bleibt über Neuanmeldungen aus); wieder einschalten über
        // die Erweiterungen-App oder den Starter „Teltonika Indicator“ (gnome-extensions enable)
        this.menu.addAction('Erweiterung deaktivieren', () => {
            if (this._idleId)
                return;
            this._idleId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                this._idleId = 0;
                Main.extensionManager.disableExtension(this._ext.uuid);
                return GLib.SOURCE_REMOVE;
            });
        });

        this._setStatus('Verbinde …');
    }

    _onConnectionSettingsChanged() {
        this._client?.destroy();
        this._client = null;
        this._failures = 0;
        this._lastError = '';
        this._reschedule(0);
    }

    _ensureClient() {
        if (!this._client) {
            this._client = new RouterClient({
                host: this._settings.get_string('host'),
                username: this._settings.get_string('username'),
                // Gepinnt wird nur in den Einstellungen nach Bestätigung, nie hier im Hintergrund
                fingerprint: this._settings.get_string('cert-fingerprint'),
                getPassword: () => lookupPassword(this._cancellable),
            });
        }
        return this._client;
    }

    _reschedule(delayS) {
        if (this._timeoutId) {
            GLib.source_remove(this._timeoutId);
            this._timeoutId = 0;
        }
        this._timeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, delayS, () => {
            this._timeoutId = 0;
            this._refresh();
            return GLib.SOURCE_REMOVE;
        });
    }

    async _refresh() {
        if (this._busy) {
            // z. B. Einstellungen geändert, während eine Abfrage lief: danach sofort neu
            this._refreshPending = true;
            return;
        }
        this._busy = true;
        this._refreshPending = false;
        const interval = this._settings.get_int('refresh-interval');
        let next = interval;
        try {
            if (!this._settings.get_string('host'))
                throw Object.assign(new Error('Router-Adresse in den Einstellungen eintragen'), {kind: 'config'});
            const client = this._ensureClient();
            const modems = await client.getModems(this._cancellable);
            this._simCards = await this._fetchSimCards(client);
            this._dataLimits = await this._fetchDataLimits(client);
            if (this._cancellable.is_cancelled())
                return;
            this._failures = 0;
            this._lastError = '';
            this._modems = modems;
            this._modem = primaryModem(modems);
            this._lastUpdate = GLib.DateTime.new_now_local();
            this._updateLabel();
            this._updateDetails();
            if (this._switching)
                next = SIM_SWITCH_POLL_S;
        } catch (e) {
            if (this._cancellable.is_cancelled())
                return;
            // 'cancelled' ohne destroy(): Client wurde wegen geänderter Einstellungen ersetzt
            next = e.kind === 'cancelled' ? 0 : this._handleError(e, interval);
        } finally {
            this._busy = false;
        }
        if (this._refreshPending)
            this._reschedule(0);
        else if (next > 0)
            this._reschedule(next);
    }

    async _fetchSimCards(client) {
        try {
            const cards = await client.getSimCards(this._cancellable);
            const operators = this._settings.get_value('sim-operators').deepUnpack();
            for (const c of cards)
                c.operator = operators[simKey(c.position, c.esimProfile)] ?? null;
            return cards;
        } catch (e) {
            if (!OPTIONAL_KINDS.includes(e.kind))
                throw e;
            // SIM-Liste ist optional – Statusanzeige soll daran nicht scheitern
            this._warnOnce(`sim_cards/status: ${e.message}`);
            return [];
        }
    }

    async _fetchDataLimits(client) {
        try {
            return await client.getDataLimits(this._cancellable);
        } catch (e) {
            if (!OPTIONAL_KINDS.includes(e.kind))
                throw e;
            this._warnOnce(`data_limit/status: ${e.message}`);
            return [];
        }
    }

    _warnOnce(message) {
        if (this._warned.has(message))
            return;
        this._warned.add(message);
        console.warn(`teltonika-indicator: ${message}`);
    }

    // Liefert die nächste Wartezeit; 0 = Polling anhalten bis Einstellungen sich ändern
    _handleError(e, interval) {
        this._failures++;
        const kind = e.kind ?? 'network';
        if (this._switching && now() - this._switching.hopStarted > SIM_HOP_TIMEOUT_S)
            this._finishSwitch('SIM-Wechsel nicht bestätigt – Router nicht erreichbar');
        this._modem = null;
        this._modems = [];
        this._icon.icon_name = ICON_OFFLINE;
        this._setQualityClass(-1);
        this._label.text = kind === 'network' ? '' : '!';
        this._setStatus(`${STATUS_TEXT[kind] ?? 'Fehler'}\n${e.message}`);
        for (const row of Object.values(this._rows))
            row.setValue('–');
        this._updateSimItem();
        this._updateDataLimit();

        // Jeden Fehler nur einmal loggen bzw. melden, nicht bei jedem Backoff-Schritt
        const errorKey = `${kind}: ${e.message}`;
        const isNew = errorKey !== this._lastError;
        this._lastError = errorKey;
        if (isNew && kind !== 'network' && kind !== 'http')
            console.warn(`teltonika-indicator: ${errorKey}`);
        if (STOP_KINDS.includes(kind)) {
            if (isNew && kind !== 'config')
                Main.notify('Teltonika Router', `${STATUS_TEXT[kind]}\n${e.message}`);
            return 0;
        }
        // Während eines SIM-Wechsels weiter dicht abfragen, das Modem startet ggf. neu
        if (this._switching)
            return SIM_SWITCH_POLL_S;
        // Leiser exponentieller Backoff (Laptop nicht im LAN, Schlüsselbund noch gesperrt etc.)
        return Math.min(interval * 2 ** Math.min(this._failures - 1, 6), MAX_BACKOFF_S);
    }

    _setStatus(text) {
        this._statusItem.label.text = text;
    }

    _setQualityClass(q) {
        for (let i = -1; i <= 4; i++)
            this._icon.remove_style_class_name(`teltonika-q${i}`);
        this._icon.add_style_class_name(`teltonika-q${q}`);
    }

    _updateLabel() {
        const m = this._modem;
        if (!m)
            return;
        const q = signalQuality(m);
        this._icon.icon_name = q < 0 ? ICON_ACQUIRING : QUALITY_ICONS[q];
        this._setQualityClass(q);
        this._label.text = formatLabel(m, {
            showNetType: this._settings.get_boolean('show-net-type'),
            showBand: this._settings.get_boolean('show-band'),
            showSignal: this._settings.get_boolean('show-signal'),
            showOperator: this._settings.get_boolean('show-operator'),
            metric: this._settings.get_string('signal-metric'),
        });
    }

    _updateDetails() {
        const m = this._modem;
        if (!m) {
            this._setStatus('Kein Modem gefunden');
            return;
        }
        const time = this._lastUpdate?.format('%H:%M:%S') ?? '';
        this._setStatus(`${m.name || 'Modem'} · Stand ${time}`);
        if (this._switching)
            this._advanceSwitch();
        else
            this._rememberOperator(m);
        this._updateSimItem();
        const r = this._rows;
        r.operator.setValue(m.operator);
        r.conntype.setValue(m.conntype);
        r.band.setValue(m.bands.length > 1 ? `${m.band} (${m.bandShort})` : m.band);
        r.rssi.setValue(formatMetric(m.rssi, 'rssi'));
        r.rsrp.setValue(formatMetric(m.rsrp, 'rsrp'));
        r.rsrq.setValue(formatMetric(m.rsrq, 'rsrq'));
        r.sinr.setValue(formatMetric(m.sinr, 'sinr'));
        r.sim.setValue([m.activeSim ? this._activeSimText(m) : null, m.simState]
            .filter(Boolean).join(' · ') || null);
        r.temperature.setValue(m.temperature !== null ? `${Number.isInteger(m.temperature) ? m.temperature : m.temperature.toFixed(1)} °C` : null);
        r.traffic.setValue(m.txBytes !== null || m.rxBytes !== null
            ? `${formatBytes(m.txBytes)} / ${formatBytes(m.rxBytes)}` : null);
        this._updateDataLimit();
    }

    // Popup-Zeilen, Panel-Warnsymbol und Benachrichtigung für das Limit der aktiven SIM
    _updateDataLimit() {
        const m = this._modem;
        const l = m?.activeSim
            ? dataLimitFor(this._dataLimits, m.id, {position: m.activeSim, esimProfile: m.esimProfile}) : null;
        this._activeLimit = l;
        const level = dataLimitLevel(l, this._settings.get_int('data-limit-warning'));
        const r = this._rows;
        r.datalimit.visible = r.limitreset.visible = Boolean(l);
        r.datalimit.setValue(formatDataLimit(l));
        r.datalimit.setValueClass(LIMIT_CLASSES[level]);
        r.limitreset.setValue(l?.due ? GLib.DateTime.new_from_unix_local(l.due).format('%a %d.%m. %H:%M') : null);
        this._limitIcon.visible = level > 0;
        for (const c of LIMIT_CLASSES.filter(Boolean))
            this._limitIcon.remove_style_class_name(c);
        if (level > 0)
            this._limitIcon.add_style_class_name(LIMIT_CLASSES[level]);
        this._clearLimitItem.visible = Boolean(l) && this._settings.get_boolean('allow-sim-switch');
        this._clearLimitItem.sensitive = !this._switching;

        if (!l)
            return;
        // Je Stufe einmal melden; nach Reset oder neuem Zeitraum wieder scharf
        const prev = this._limitNotified[l.interface] ?? 0;
        this._limitNotified[l.interface] = level;
        if (level > prev) {
            const sim = this._activeSimText(m);
            Main.notify('Teltonika Router', level === 2
                ? `Datenlimit von ${sim} ausgeschöpft (${formatDataLimit(l)})`
                : `${sim}: Datenlimit fast erreicht (${formatDataLimit(l)})`);
        }
    }

    // Ohne Betreiber – der steht in der Popup-Zeile darüber
    _activeSimText(m) {
        const card = this._simCards.find(c => (!c.modem || c.modem === m.id) && isActiveSim(m, c));
        // modems/status meldet esim_profile, solange eine eSIM aktiv ist
        return simLabel({position: m.activeSim, esimProfile: card ? card.esimProfile : m.esimProfile});
    }

    // Betreiber der aktiven SIM merken, damit das Wechsel-Menü ihn auch für inaktive SIMs zeigt.
    // Nur mit Netz und außerhalb eines Wechsels, sonst könnte er noch von der vorigen SIM stammen.
    _rememberOperator(m) {
        if (!m.activeSim || !m.operator || !m.netType)
            return;
        const key = simKey(m.activeSim, m.esimProfile);
        const operators = this._settings.get_value('sim-operators').deepUnpack();
        if (operators[key] === m.operator)
            return;
        operators[key] = m.operator;
        this._settings.set_value('sim-operators', new GLib.Variant('a{ss}', operators));
        for (const c of this._simCards) {
            if (simKey(c.position, c.esimProfile) === key)
                c.operator = m.operator;
        }
    }

    // SIMs dieses Modems ohne ausgeblendete Slots
    _visibleSimCards() {
        const m = this._modem;
        if (!m || !this._settings.get_boolean('allow-sim-switch'))
            return [];
        const hidden = this._settings.get_value('hidden-sim-slots').deepUnpack();
        return this._simCards.filter(c =>
            (!c.modem || c.modem === m.id) && c.position !== null && !hidden.includes(c.position));
    }

    _simTargets() {
        return this._visibleSimCards().filter(c => !isActiveSim(this._modem, c));
    }

    _updateSimItem() {
        const targets = this._simTargets();
        this._simItem.visible = targets.length > 0 || Boolean(this._switching);
        this._simItem.label.text = this._switching ? 'SIM-Wechsel läuft …' : 'SIM wechseln';
        this._simItem.sensitive = !this._switching;
        this._fillSubmenu(this._simItem, '_simKey', targets,
            card => `Zu ${simLabel(card)} wechseln${this._limitSuffix(card)}`, card => this._confirmSimSwitch(card));

        const cards = this._visibleSimCards();
        const current = cards.find(c => c.primary);
        this._defaultItem.visible = cards.length > 1;
        this._defaultItem.label.text = `Standard-SIM: ${current ? simLabel(current) : '–'}`;
        this._defaultItem.sensitive = !this._switching;
        this._fillSubmenu(this._defaultItem, '_defaultKey', cards.filter(c => !c.primary),
            card => `${simLabel(card)} als Standard festlegen`, card => this._confirmDefaultSim(card));
    }

    // Verbrauch einer anderen SIM, z. B. „ · Limit 96 %“
    _limitSuffix(card) {
        const l = dataLimitFor(this._dataLimits, this._modem?.id, card);
        return l ? ` · Limit ${dataLimitPercent(l)} %` : '';
    }

    // Untermenü nur neu bauen, wenn sich die Einträge geändert haben
    _fillSubmenu(item, keyProp, cards, label, action) {
        const key = cards.map(label).join('\n');
        if (key === this[keyProp])
            return;
        this[keyProp] = key;
        item.menu.removeAll();
        for (const card of cards)
            item.menu.addAction(label(card), () => action(card));
    }

    // Schreibende Aktionen: Enter/Escape brechen ab, bestätigt wird nur per Klick auf okLabel
    _confirm(title, description, okLabel, onOk) {
        this._dialog?.close();
        const dialog = new ModalDialog.ModalDialog({styleClass: 'teltonika-dialog'});
        dialog.contentLayout.add_child(new Dialog.MessageDialogContent({title, description}));
        dialog.addButton({label: 'Abbrechen', action: () => dialog.close(), key: Clutter.KEY_Escape, default: true});
        dialog.addButton({
            label: okLabel,
            action: () => {
                dialog.close();
                onOk();
            },
        });
        dialog.connect('closed', () => {
            if (this._dialog === dialog)
                this._dialog = null;
        });
        this._dialog = dialog;
        dialog.open();
    }

    _modemById(id) {
        return this._modems.find(m => m.id === id) ?? null;
    }

    _confirmSimSwitch(card) {
        const id = this._modem?.id;
        if (id === undefined || this._switching)
            return;
        this._confirm(`Zu ${simLabel(card)} wechseln?`,
            'Der Router schaltet zur nächsten SIM, notfalls mehrmals, bis ' +
            `${simLabel(card)} aktiv ist. Die Mobilfunkverbindung ist dabei für einige ` +
            'Sekunden bis wenige Minuten unterbrochen. Die Standard-SIM bleibt unverändert.',
            'Wechseln', () => {
                // Aktueller Stand, nicht der beim Öffnen des Dialogs
                const m = this._modemById(id);
                if (m && !this._switching)
                    this._switchSim(m, card);
            });
    }

    _confirmDefaultSim(card) {
        this._confirm(`${simLabel(card)} als Standard-SIM festlegen?`,
            'Die aktive Verbindung bleibt bestehen. Die Standard-SIM wird z. B. nach einem ' +
            'Neustart des Routers oder einem Verbindungsneuaufbau verwendet.',
            'Festlegen', () => this._setDefaultSim(card));
    }

    async _setDefaultSim(card) {
        try {
            await this._ensureClient().setDefaultSim(card.id, this._cancellable);
        } catch (e) {
            if (!this._cancellable.is_cancelled())
                Main.notify('Teltonika Router', `Standard-SIM ändern fehlgeschlagen: ${e.message}${this._rightsHint(e)}`);
            return;
        }
        for (const c of this._simCards)
            c.primary = c.id === card.id;
        this._updateSimItem();
        Main.notify('Teltonika Router', `Standard-SIM ist jetzt ${simLabel(card)}`);
    }

    _confirmClearLimit() {
        const l = this._activeLimit;
        const m = this._modem;
        if (!l || !m)
            return;
        const sim = this._activeSimText(m);
        this._confirm(`Datenlimit von ${sim} zurücksetzen?`,
            `Der Zähler (${formatDataLimit(l)}) wird auf 0 gesetzt. ` +
            'Das lässt sich nicht rückgängig machen.',
            'Zurücksetzen', () => this._clearLimit(l.interface, sim));
    }

    async _clearLimit(iface, sim) {
        try {
            await this._ensureClient().clearDataLimit(iface, this._cancellable);
        } catch (e) {
            if (!this._cancellable.is_cancelled())
                Main.notify('Teltonika Router', `Datenlimit zurücksetzen fehlgeschlagen: ${e.message}${this._rightsHint(e)}`);
            return;
        }
        Main.notify('Teltonika Router', `Datenlimit von ${sim} zurückgesetzt`);
        this._reschedule(0);
    }

    _updateRebootItem() {
        this._rebootItem.visible = this._settings.get_boolean('allow-reboot');
        this._rebootItem.sensitive = !this._switching;
    }

    _confirmReboot() {
        if (this._switching)
            return;
        this._confirm('Router neu starten?',
            'Internet und WLAN sind für einige Minuten unterbrochen. ' +
            'Danach verbindet sich der Router mit der Standard-SIM.',
            'Neu starten', () => this._reboot());
    }

    async _reboot() {
        try {
            await this._ensureClient().reboot(this._cancellable);
        } catch (e) {
            if (!this._cancellable.is_cancelled()) {
                Main.notify('Teltonika Router', `Neustart fehlgeschlagen: ${e.message}${e.kind === 'forbidden'
                    ? '\nDer RutOS-Benutzer braucht Schreibrecht für System → Administration.' : ''}`);
            }
            return;
        }
        Main.notify('Teltonika Router', 'Router startet neu');
        this._setStatus('Router startet neu …');
        // Nicht sofort abfragen: der Router antwortet sonst noch kurz vor dem Neustart
        this._failures = 0;
        this._lastError = '';
        this._reschedule(REBOOT_WAIT_S);
    }

    _rightsHint(e) {
        return e.kind === 'forbidden'
            ? '\nDer RutOS-Benutzer braucht Schreibrecht für die mobilen Einstellungen.' : '';
    }

    // Aktive SIM als Vergleichsschlüssel (Slot + eSIM-Profil)
    _simKeyOf(m) {
        return `${m.activeSim}/${m.esimProfile ?? ''}`;
    }

    async _switchSim(m, card) {
        const maxHops = this._simCards.filter(c => !c.modem || c.modem === m.id).length || 2;
        this._switching = {
            modemId: m.id, target: card, hops: 0, maxHops, lastKey: this._simKeyOf(m), hopStarted: now(),
        };
        this._updateSimItem();
        this._updateRebootItem();
        this._setStatus(`Wechsle zu ${simLabel(card)} …`);
        await this._hop();
    }

    // Ein Schritt: POST switch_sim (Router wechselt zur nächsten SIM)
    async _hop() {
        const s = this._switching;
        s.hops++;
        s.hopStarted = now();
        try {
            await this._ensureClient().switchSim(s.modemId, this._cancellable);
        } catch (e) {
            if (!this._cancellable.is_cancelled())
                this._finishSwitch(`SIM-Wechsel fehlgeschlagen: ${e.message}${this._rightsHint(e)}`);
            return;
        }
        this._reschedule(SIM_SWITCH_POLL_S);
    }

    // Bei jeder Abfrage während des Wechsels: fertig, weiterschalten oder abbrechen.
    // Immer das Modem, das gewechselt wird – nicht das gerade angezeigte (mehrere Modems).
    _advanceSwitch() {
        const s = this._switching;
        const {target} = s;
        const m = this._modemById(s.modemId);
        if (!m) {
            if (now() - s.hopStarted > SIM_HOP_TIMEOUT_S)
                this._finishSwitch('SIM-Wechsel nicht bestätigt – Modem wird nicht mehr gemeldet');
            return;
        }
        if (isActiveSim(m, target)) {
            if (m.netType)
                this._finishSwitch(`${simLabel(target)} ist aktiv (${formatLabel(m)})`);
            else if (now() - s.hopStarted > SIM_HOP_TIMEOUT_S)
                this._finishSwitch(`${simLabel(target)} ist aktiv, aber noch ohne Netz`);
            else
                this._setStatus(`${simLabel(target)} aktiv, verbinde …`);
            return;
        }
        const key = this._simKeyOf(m);
        if (key !== s.lastKey) {
            // Router ist auf einer anderen SIM gelandet (z. B. leerer Slot) → weiter
            s.lastKey = key;
            if (s.hops >= s.maxHops) {
                this._finishSwitch(`${simLabel(target)} nicht erreicht – aktiv ist ${this._activeSimText(m)}`);
                return;
            }
            this._setStatus(`Bei ${this._activeSimText(m)} gelandet, schalte weiter …`);
            this._hop();
            return;
        }
        if (now() - s.hopStarted > SIM_HOP_TIMEOUT_S) {
            this._finishSwitch(`SIM-Wechsel nicht bestätigt – aktiv ist ${this._activeSimText(m)}`);
            return;
        }
        this._setStatus(`Wechsle zu ${simLabel(target)} … (Schritt ${s.hops})`);
    }

    _finishSwitch(message) {
        this._switching = null;
        this._updateSimItem();
        this._updateRebootItem();
        Main.notify('Teltonika Router', message);
    }

    destroy() {
        this._cancellable.cancel();
        this._dialog?.close();
        this._dialog = null;
        if (this._timeoutId) {
            GLib.source_remove(this._timeoutId);
            this._timeoutId = 0;
        }
        if (this._idleId) {
            GLib.source_remove(this._idleId);
            this._idleId = 0;
        }
        for (const id of this._settingsIds)
            this._settings.disconnect(id);
        this._settingsIds = [];
        this._client?.destroy();
        this._client = null;
        this._settings = null;
        super.destroy();
    }
});

export default class TeltonikaIndicatorExtension extends Extension {
    enable() {
        this._indicator = new TeltonikaIndicator(this);
        Main.panel.addToStatusArea(this.uuid, this._indicator);
    }

    disable() {
        this._indicator?.destroy();
        this._indicator = null;
    }
}
