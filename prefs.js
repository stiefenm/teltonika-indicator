import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {RouterClient} from './lib/client.js';
import {_, fmt} from './lib/i18n.js';
import {lookupPassword, storePassword} from './lib/secret.js';
import {formatLabel, primaryModem} from './lib/parse.js';

const METRICS = [
    ['rsrp', 'RSRP (dBm)'],
    ['rssi', 'RSSI (dBm)'],
    ['rsrq', 'RSRQ (dB)'],
    ['sinr', 'SINR (dB)'],
];

export default class TeltonikaPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        window._settings = settings;
        window.set_default_size(620, 760);

        // Laufende Router-Abfragen beim Schließen abbrechen
        const cancellable = new Gio.Cancellable();
        window.connect('close-request', () => {
            cancellable.cancel();
            return false;
        });

        const page = new Adw.PreferencesPage({icon_name: 'network-cellular-symbolic'});
        window.add(page);

        page.add(this._routerGroup(settings, window, cancellable));
        page.add(this._certGroup(settings));
        page.add(this._displayGroup(settings));
    }

    _routerGroup(settings, window, cancellable) {
        const group = new Adw.PreferencesGroup({
            title: _('Router'),
            description: _('RutOS 7.x REST API. Recommended: a separate user with read access ' +
                '(plus write access to Network → Mobile or System → Administration ' +
                'for SIM actions or restarting).'),
        });

        const host = new Adw.EntryRow({title: _('Address (e.g. 192.168.1.1)'), show_apply_button: true});
        host.text = settings.get_string('host');
        host.connect('apply', () => this._setHost(settings, host.text));
        group.add(host);

        const user = new Adw.EntryRow({title: _('Username'), show_apply_button: true});
        user.text = settings.get_string('username');
        user.connect('apply', () => settings.set_string('username', user.text.trim()));
        group.add(user);

        const pass = new Adw.PasswordEntryRow({title: _('Password (keyring)'), show_apply_button: true});
        this._lookup().then(p => {
            if (p)
                pass.text = p;
        }).catch(e => console.warn(`Passwort lesen: ${e.message}`));
        pass.connect('apply', () => {
            // Die Extension liest das Passwort bei jedem Login neu aus dem Schlüsselbund
            this._passwordPromise = null;
            storePassword(pass.text)
                .then(() => this._passwordStored(settings))
                .catch(e => this._toast(group, fmt(_('Saving failed: {error}'), {error: e.message})));
        });
        group.add(pass);

        const interval = new Adw.SpinRow({
            title: _('Refresh interval'),
            subtitle: _('Seconds'),
            adjustment: new Gtk.Adjustment({lower: 5, upper: 300, step_increment: 5, page_increment: 30}),
        });
        settings.bind('refresh-interval', interval, 'value', Gio.SettingsBindFlags.DEFAULT);
        group.add(interval);

        const sim = new Adw.SwitchRow({
            title: _('Offer SIM actions in the menu'),
            subtitle: _('Switch SIM, default SIM and reset data limit – ' +
                'the user needs write access to the mobile settings'),
        });
        settings.bind('allow-sim-switch', sim, 'active', Gio.SettingsBindFlags.DEFAULT);
        group.add(sim);

        group.add(this._simSlotsRow(settings, cancellable));

        const reboot = new Adw.SwitchRow({
            title: _('Offer “Restart router” in the menu'),
            subtitle: _('The user needs write access to System → Administration'),
        });
        settings.bind('allow-reboot', reboot, 'active', Gio.SettingsBindFlags.DEFAULT);
        group.add(reboot);

        // use_markup aus: Betreiber und Fehlertexte kommen vom Router
        const test = new Adw.ActionRow({
            title: _('Test connection'), subtitle: _('Applies pending input first'), use_markup: false,
        });
        const btn = new Gtk.Button({label: _('Test'), valign: Gtk.Align.CENTER});
        btn.connect('clicked', async () => {
            // Nicht übernommene Eingaben gelten für den Test mit
            this._setHost(settings, host.text);
            settings.set_string('username', user.text.trim());
            if (pass.text) {
                await storePassword(pass.text).then(() => this._passwordStored(settings)).catch(() => {});
            }
            btn.sensitive = false;
            test.subtitle = _('Connecting…');
            try {
                test.subtitle = await this._testConnection(settings, window, cancellable,
                    async () => pass.text || this._lookup());
            } catch (e) {
                if (e.kind === 'cancelled')
                    return;
                test.subtitle = fmt(_('Error ({kind}): {error}'), {kind: e.kind ?? _('unknown'), error: e.message});
            }
            btn.sensitive = true;
        });
        test.add_suffix(btn);
        group.add(test);

        return group;
    }

    // Verbindungstest; ein unbekanntes oder geändertes Zertifikat wird erst nach Bestätigung gepinnt.
    // Ohne Pin bricht der TLS-Handshake ab, bevor das Passwort gesendet wird.
    async _testConnection(settings, window, cancellable, getPassword) {
        for (;;) {
            const client = new RouterClient({
                host: settings.get_string('host'),
                username: settings.get_string('username'),
                getPassword,
                fingerprint: settings.get_string('cert-fingerprint'),
            });
            try {
                const m = primaryModem(await client.getModems(cancellable));
                return m
                    ? fmt(_('OK – {status}'), {status: [m.operator, formatLabel(m)].filter(Boolean).join(' · ')})
                    : _('OK – but no modem reported');
            } catch (e) {
                if ((e.kind !== 'untrusted' && e.kind !== 'cert') || cancellable.is_cancelled())
                    throw e;
                if (!await this._confirmCertificate(window, settings.get_string('host'), e.fingerprint, e.kind === 'cert'))
                    return _('Cancelled – certificate not confirmed');
                settings.set_string('cert-fingerprint', e.fingerprint);
            } finally {
                client.destroy();
            }
        }
    }

    _confirmCertificate(window, host, fingerprint, changed) {
        const dialog = new Adw.AlertDialog({
            heading: changed ? _('Certificate has changed') : _('Confirm certificate'),
            body: `${changed
                ? _('The router presents a different certificate than before. This is normal after a ' +
                    'firmware update or reset, but it can also be an attack on the network.')
                : _('The router’s certificate is self-signed. Only trust it if the fingerprint matches.')}\n\n` +
                `SHA-256:\n${fingerprint}\n\n` +
                `${_('To compare, over a secure path (e.g. via cable):')}\n` +
                `openssl s_client -connect ${host}:443 </dev/null | openssl x509 -noout -fingerprint -sha256`,
            close_response: 'cancel',
            default_response: 'cancel',
        });
        dialog.add_response('cancel', _('Cancel'));
        dialog.add_response('trust', _('Trust'));
        dialog.set_response_appearance('trust', changed ? Adw.ResponseAppearance.DESTRUCTIVE
            : Adw.ResponseAppearance.SUGGESTED);
        return new Promise(resolve => {
            dialog.connect('response', (_d, response) => resolve(response === 'trust'));
            dialog.present(window);
        });
    }

    // Neue Adresse → alter Pin gilt nicht mehr
    _setHost(settings, text) {
        const host = text.trim();
        if (host === settings.get_string('host'))
            return;
        settings.set_string('host', host);
        settings.set_string('cert-fingerprint', '');
    }

    // Die Extension bemerkt Änderungen im Schlüsselbund nicht – Zähler anstoßen
    _passwordStored(settings) {
        settings.set_uint('password-serial', settings.get_uint('password-serial') + 1);
    }

    // Ein Schalter pro SIM-Slot; Slots kommen vom Router, sonst 1–3 als Ersatz
    _simSlotsRow(settings, cancellable) {
        const row = new Adw.ExpanderRow({
            title: _('SIM slots in the menu'),
            subtitle: _('Turn off empty slots – the router does not report whether a slot is occupied'),
        });
        settings.bind('allow-sim-switch', row, 'sensitive', Gio.SettingsBindFlags.GET);

        const hidden = () => settings.get_value('hidden-sim-slots').deepUnpack();
        const setHidden = (pos, hide) => {
            const set = new Set(hidden());
            if (hide)
                set.add(pos);
            else
                set.delete(pos);
            settings.set_value('hidden-sim-slots',
                new GLib.Variant('ai', [...set].sort((x, y) => x - y)));
        };

        let rows = [];
        const build = slots => {
            rows.forEach(r => row.remove(r));
            const operators = settings.get_value('sim-operators').deepUnpack();
            rows = slots.map(({position, esimProfile = null, title}) => {
                const op = operators[`${position}/${esimProfile ?? ''}`];
                const sw = new Adw.SwitchRow({
                    title, subtitle: op ? fmt(_('Last seen: {operator}'), {operator: op}) : '', active: !hidden().includes(position), use_markup: false,
                });
                sw.connect('notify::active', () => setHidden(position, !sw.active));
                row.add_row(sw);
                return sw;
            });
        };

        const fallback = () => [...new Set([1, 2, 3, ...hidden()])].sort((x, y) => x - y)
            .map(position => ({position, title: `SIM ${position}`}));
        build(fallback());

        if (settings.get_string('host')) {
            const client = new RouterClient({
                host: settings.get_string('host'),
                username: settings.get_string('username'),
                getPassword: () => this._lookup(),
                fingerprint: settings.get_string('cert-fingerprint'),
            });
            // Ohne bestätigtes Zertifikat schlägt das fehl → Ersatz-Slots bleiben
            client.getSimCards(cancellable).then(cards => {
                if (!cards.length)
                    return;
                // Ein Slot kann mehrere eSIM-Profile haben → pro Position eine Zeile
                const byPos = new Map();
                for (const c of cards) {
                    if (c.position !== null && !byPos.has(c.position))
                        byPos.set(c.position, c);
                }
                build([...byPos.values()].sort((x, y) => x.position - y.position)
                    .map(c => ({position: c.position, esimProfile: c.esimProfile, title: c.esimProfile ? `SIM ${c.position} (eSIM)` : `SIM ${c.position}`})));
            }).catch(e => {
                if (e.kind !== 'cancelled' && e.kind !== 'untrusted')
                    console.warn(`SIM-Slots laden: ${e.message}`);
            })
                .finally(() => client.destroy());
        }
        return row;
    }

    _certGroup(settings) {
        const group = new Adw.PreferencesGroup({
            title: _('Certificate'),
            description: _('Self-signed certificates are pinned after confirmation when you click “Test”. ' +
                'If the certificate changes, the connection is blocked until it is confirmed again.'),
        });
        const row = new Adw.ActionRow({title: _('SHA-256 fingerprint'), subtitle_selectable: true});
        row.add_css_class('property');
        const update = () => {
            const fp = settings.get_string('cert-fingerprint');
            row.subtitle = fp || _('none saved yet');
        };
        update();
        settings.connect('changed::cert-fingerprint', update);

        const reset = new Gtk.Button({label: _('Forget'), valign: Gtk.Align.CENTER});
        reset.add_css_class('destructive-action');
        reset.connect('clicked', () => settings.set_string('cert-fingerprint', ''));
        row.add_suffix(reset);
        group.add(row);
        return group;
    }

    _displayGroup(settings) {
        const group = new Adw.PreferencesGroup({title: _('Shown in the top bar')});
        for (const [key, title] of [
            ['show-operator', _('Operator')],
            ['show-net-type', _('Network type (5G/4G/3G)')],
            ['show-band', _('Band')],
            ['show-signal', _('Signal value')],
        ]) {
            const sw = new Adw.SwitchRow({title});
            settings.bind(key, sw, 'active', Gio.SettingsBindFlags.DEFAULT);
            group.add(sw);
        }

        const combo = new Adw.ComboRow({
            title: _('Signal metric'),
            subtitle: _('Shown when “Signal value” is on'),
            model: Gtk.StringList.new(METRICS.map(m => m[1])),
        });
        const sync = () => {
            const i = METRICS.findIndex(m => m[0] === settings.get_string('signal-metric'));
            combo.selected = Math.max(i, 0);
        };
        sync();
        settings.connect('changed::signal-metric', sync);
        combo.connect('notify::selected', () =>
            settings.set_string('signal-metric', METRICS[combo.selected][0]));
        group.add(combo);

        const warn = new Adw.SpinRow({
            title: _('Data limit warning'),
            subtitle: _('Yellow warning icon from this usage in percent, 0 = only when the limit is used up (red)'),
            adjustment: new Gtk.Adjustment({lower: 0, upper: 99, step_increment: 1, page_increment: 10}),
        });
        settings.bind('data-limit-warning', warn, 'value', Gio.SettingsBindFlags.DEFAULT);
        group.add(warn);
        return group;
    }

    // Eine gemeinsame Schlüsselbund-Abfrage: parallele Lookups blockieren sich gegenseitig (~10 s)
    _lookup() {
        this._passwordPromise ??= lookupPassword().catch(e => {
            this._passwordPromise = null;
            throw e;
        });
        return this._passwordPromise;
    }

    _toast(widget, title) {
        widget.get_root()?.add_toast?.(new Adw.Toast({title, use_markup: false}));
    }
}
