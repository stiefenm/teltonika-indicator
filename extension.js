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
    formatBytes, formatLabel, formatMetric, isActiveSim, primaryModem, signalQuality, simLabel,
} from './lib/parse.js';

const MAX_BACKOFF_S = 300;
// Nach einem SIM-Wechsel häufiger abfragen, bis die neue SIM gemeldet wird
const SIM_SWITCH_POLL_S = 5;
const SIM_SWITCH_TIMEOUT_S = 120;

const QUALITY_ICONS = [
    'network-cellular-signal-none-symbolic',
    'network-cellular-signal-weak-symbolic',
    'network-cellular-signal-ok-symbolic',
    'network-cellular-signal-good-symbolic',
    'network-cellular-signal-excellent-symbolic',
];
const ICON_OFFLINE = 'network-cellular-offline-symbolic';
const ICON_ACQUIRING = 'network-cellular-acquiring-symbolic';

const STATUS_TEXT = {
    config: 'Nicht konfiguriert',
    auth: 'Anmeldung fehlgeschlagen',
    forbidden: 'Fehlende Berechtigung',
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
        this._simCards = [];
        this._switching = null; // {target, started} während eines SIM-Wechsels
        this._cancellable = new Gio.Cancellable();

        const box = new St.BoxLayout({style_class: 'panel-status-menu-box'});
        this._icon = new St.Icon({icon_name: ICON_ACQUIRING, style_class: 'system-status-icon'});
        this._label = new St.Label({
            text: '',
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'teltonika-label',
        });
        box.add_child(this._icon);
        box.add_child(this._label);
        this.add_child(box);

        this._buildMenu();

        this._settingsIds = ['host', 'username'].map(k =>
            this._settings.connect(`changed::${k}`, () => this._onConnectionSettingsChanged()));
        this._settingsIds.push(this._settings.connect('changed::cert-fingerprint', () => {
            if (!this._ignoreFpChange)
                this._onConnectionSettingsChanged();
        }));
        this._settingsIds.push(this._settings.connect('changed::refresh-interval', () => this._reschedule(0)));
        for (const k of ['allow-sim-switch', 'hidden-sim-slots'])
            this._settingsIds.push(this._settings.connect(`changed::${k}`, () => this._reschedule(0)));
        for (const k of ['show-net-type', 'show-band', 'show-signal', 'show-operator', 'signal-metric'])
            this._settingsIds.push(this._settings.connect(`changed::${k}`, () => this._updateLabel()));

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
        this.menu.addAction('Router-Weboberfläche öffnen', () => {
            if (this._client?.baseUrl)
                Gio.AppInfo.launch_default_for_uri(this._client.baseUrl, null);
        });
        this.menu.addAction('Einstellungen', () => this._ext.openPreferences());

        this._setStatus('Verbinde …');
    }

    _onConnectionSettingsChanged() {
        this._client?.destroy();
        this._client = null;
        this._failures = 0;
        this._reschedule(0);
    }

    _ensureClient() {
        if (!this._client) {
            this._client = new RouterClient({
                host: this._settings.get_string('host'),
                username: this._settings.get_string('username'),
                fingerprint: this._settings.get_string('cert-fingerprint'),
                getPassword: () => lookupPassword(this._cancellable),
                onFingerprint: fp => {
                    // TOFU: erster Kontakt – Fingerprint dauerhaft pinnen.
                    // Kein Client-Neubau nötig, der aktuelle kennt ihn bereits.
                    this._ignoreFpChange = true;
                    this._settings.set_string('cert-fingerprint', fp);
                    this._ignoreFpChange = false;
                },
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
        if (this._busy)
            return;
        this._busy = true;
        const interval = this._settings.get_int('refresh-interval');
        let next = interval;
        try {
            if (!this._settings.get_string('host'))
                throw Object.assign(new Error('Router-Adresse in den Einstellungen eintragen'), {kind: 'config'});
            const client = this._ensureClient();
            const modems = await client.getModems(this._cancellable);
            if (this._settings.get_boolean('allow-sim-switch'))
                this._simCards = await this._fetchSimCards(client);
            else
                this._simCards = [];
            if (this._cancellable.is_cancelled())
                return;
            this._failures = 0;
            this._modem = primaryModem(modems);
            this._lastUpdate = GLib.DateTime.new_now_local();
            this._updateLabel();
            this._updateDetails();
            if (this._switching)
                next = SIM_SWITCH_POLL_S;
        } catch (e) {
            if (e.kind === 'cancelled' || this._cancellable.is_cancelled())
                return;
            next = this._handleError(e, interval);
        } finally {
            this._busy = false;
        }
        if (next > 0)
            this._reschedule(next);
    }

    async _fetchSimCards(client) {
        try {
            return await client.getSimCards(this._cancellable);
        } catch (e) {
            if (e.kind === 'cancelled')
                throw e;
            // SIM-Liste ist optional – Statusanzeige soll daran nicht scheitern
            console.warn(`teltonika-indicator: sim_cards/status: ${e.message}`);
            return [];
        }
    }

    // Liefert die nächste Wartezeit; 0 = Polling anhalten bis Einstellungen sich ändern
    _handleError(e, interval) {
        this._failures++;
        const kind = e.kind ?? 'network';
        if (this._switching &&
            GLib.get_monotonic_time() / 1e6 - this._switching.started > SIM_SWITCH_TIMEOUT_S)
            this._switching = null;
        this._modem = null;
        this._icon.icon_name = ICON_OFFLINE;
        this._setQualityClass(-1);
        this._label.text = kind === 'network' ? '' : '!';
        this._setStatus(`${STATUS_TEXT[kind] ?? 'Fehler'}\n${e.message}`);
        for (const row of Object.values(this._rows))
            row.setValue('–');
        this._updateSimItem();

        if (kind === 'config' || kind === 'cert')
            return 0;
        if (kind !== 'network' && kind !== 'http')
            console.warn(`teltonika-indicator: ${kind}: ${e.message}`);
        // Leiser exponentieller Backoff (Laptop nicht im LAN etc.)
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
        if (this._switching) {
            const {target, started} = this._switching;
            const elapsed = GLib.get_monotonic_time() / 1e6 - started;
            if (isActiveSim(m, target) && m.netType) {
                this._switching = null;
                Main.notify('Teltonika Router', `${simLabel(target)} ist aktiv (${formatLabel(m)})`);
            } else if (elapsed > SIM_SWITCH_TIMEOUT_S) {
                this._switching = null;
                Main.notify('Teltonika Router',
                    `SIM-Wechsel nicht bestätigt – aktiv ist ${this._activeSimText(m)}`);
            } else {
                this._setStatus(`Wechsle zu ${simLabel(target)} …`);
            }
        }
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
    }

    _activeSimText(m) {
        const card = this._simCards.find(c => (!c.modem || c.modem === m.id) && isActiveSim(m, c));
        return card ? simLabel(card) : `SIM ${m.activeSim}`;
    }

    // Wechselziele: SIMs dieses Modems außer der aktiven und den ausgeblendeten Slots
    _simTargets() {
        const m = this._modem;
        if (!m || !this._settings.get_boolean('allow-sim-switch'))
            return [];
        const hidden = this._settings.get_value('hidden-sim-slots').deepUnpack();
        return this._simCards.filter(c =>
            (!c.modem || c.modem === m.id) && c.position !== null &&
            !hidden.includes(c.position) && !isActiveSim(m, c));
    }

    _updateSimItem() {
        const targets = this._simTargets();
        this._simItem.visible = targets.length > 0 || Boolean(this._switching);
        this._simItem.label.text = this._switching ? 'SIM-Wechsel läuft …' : 'SIM wechseln';
        this._simItem.sensitive = !this._switching;

        // Untermenü nur neu bauen, wenn sich die Ziele geändert haben
        const key = targets.map(c => c.id).join(',');
        if (key === this._simKey)
            return;
        this._simKey = key;
        this._simItem.menu.removeAll();
        for (const card of targets) {
            this._simItem.menu.addAction(`Zu ${simLabel(card)} wechseln`,
                () => this._confirmSimSwitch(card));
        }
    }

    _confirmSimSwitch(card) {
        const m = this._modem;
        if (!m || this._switching)
            return;
        const dialog = new ModalDialog.ModalDialog({styleClass: 'teltonika-dialog'});
        dialog.contentLayout.add_child(new Dialog.MessageDialogContent({
            title: `Zu ${simLabel(card)} wechseln?`,
            description: `${simLabel(card)} wird Standard-SIM, danach baut der Router die ` +
                'Mobilfunkverbindung neu auf. Sie ist dabei für einige Sekunden bis etwa ' +
                'eine Minute unterbrochen.',
        }));
        dialog.addButton({label: 'Abbrechen', action: () => dialog.close(), key: Clutter.KEY_Escape});
        dialog.addButton({
            label: 'Wechseln',
            default: true,
            action: () => {
                dialog.close();
                this._switchSim(m, card);
            },
        });
        dialog.open();
    }

    async _switchSim(m, card) {
        this._switching = {target: card, started: GLib.get_monotonic_time() / 1e6};
        this._updateSimItem();
        this._setStatus(`Wechsle zu ${simLabel(card)} …`);
        try {
            await this._ensureClient().activateSim(m.id, card.id, this._cancellable);
        } catch (e) {
            if (this._cancellable.is_cancelled())
                return;
            this._switching = null;
            this._updateSimItem();
            const hint = e.kind === 'forbidden'
                ? '\nDer RutOS-Benutzer braucht Schreibrecht für die mobilen Einstellungen.' : '';
            Main.notify('Teltonika Router', `SIM-Wechsel fehlgeschlagen: ${e.message}${hint}`);
            return;
        }
        this._reschedule(SIM_SWITCH_POLL_S);
    }

    destroy() {
        this._cancellable.cancel();
        if (this._timeoutId) {
            GLib.source_remove(this._timeoutId);
            this._timeoutId = 0;
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
