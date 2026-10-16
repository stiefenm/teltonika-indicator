import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {RouterClient} from './lib/client.js';
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

        const page = new Adw.PreferencesPage({icon_name: 'network-cellular-symbolic'});
        window.add(page);

        page.add(this._routerGroup(settings));
        page.add(this._certGroup(settings));
        page.add(this._displayGroup(settings));
    }

    _routerGroup(settings) {
        const group = new Adw.PreferencesGroup({
            title: 'Router',
            description: 'RutOS 7.x REST-API. Empfohlen: eigener Benutzer mit Leserechten ' +
                '(plus Schreibrecht für Netzwerk → Mobilfunk, falls SIM-Wechsel gewünscht).',
        });

        const host = new Adw.EntryRow({title: 'Adresse (z. B. 192.168.1.1)', show_apply_button: true});
        host.text = settings.get_string('host');
        host.connect('apply', () => settings.set_string('host', host.text.trim()));
        group.add(host);

        const user = new Adw.EntryRow({title: 'Benutzername', show_apply_button: true});
        user.text = settings.get_string('username');
        user.connect('apply', () => settings.set_string('username', user.text.trim()));
        group.add(user);

        const pass = new Adw.PasswordEntryRow({title: 'Passwort (Schlüsselbund)', show_apply_button: true});
        lookupPassword().then(p => {
            if (p)
                pass.text = p;
        }).catch(e => console.warn(`Passwort lesen: ${e.message}`));
        pass.connect('apply', () => {
            // Die Extension liest das Passwort bei jedem Login neu aus dem Schlüsselbund
            storePassword(pass.text)
                .catch(e => this._toast(group, `Speichern fehlgeschlagen: ${e.message}`));
        });
        group.add(pass);

        const interval = new Adw.SpinRow({
            title: 'Abfrageintervall',
            subtitle: 'Sekunden',
            adjustment: new Gtk.Adjustment({lower: 5, upper: 300, step_increment: 5, page_increment: 30}),
        });
        settings.bind('refresh-interval', interval, 'value', Gio.SettingsBindFlags.DEFAULT);
        group.add(interval);

        const sim = new Adw.SwitchRow({
            title: 'SIM-Wechsel im Menü anbieten',
            subtitle: 'Benutzer braucht Schreibrecht für die mobilen Einstellungen',
        });
        settings.bind('allow-sim-switch', sim, 'active', Gio.SettingsBindFlags.DEFAULT);
        group.add(sim);

        const hidden = new Adw.EntryRow({
            title: 'Ausgeblendete SIM-Slots (z. B. leere: 2)',
            show_apply_button: true,
        });
        const slotsText = () => settings.get_value('hidden-sim-slots').deepUnpack().join(', ');
        hidden.text = slotsText();
        hidden.connect('apply', () => {
            const slots = [...new Set(hidden.text.split(/[\s,;]+/).map(Number)
                .filter(n => Number.isInteger(n) && n > 0))];
            settings.set_value('hidden-sim-slots', new GLib.Variant('ai', slots));
            hidden.text = slotsText();
        });
        settings.bind('allow-sim-switch', hidden, 'sensitive', Gio.SettingsBindFlags.GET);
        group.add(hidden);

        const test = new Adw.ActionRow({title: 'Verbindung testen', subtitle: 'Übernimmt zuerst offene Eingaben'});
        const btn = new Gtk.Button({label: 'Testen', valign: Gtk.Align.CENTER});
        btn.connect('clicked', async () => {
            // Nicht übernommene Eingaben gelten für den Test mit
            settings.set_string('host', host.text.trim());
            settings.set_string('username', user.text.trim());
            if (pass.text)
                await storePassword(pass.text).catch(() => {});
            btn.sensitive = false;
            test.subtitle = 'Verbinde …';
            const client = new RouterClient({
                host: host.text,
                username: user.text.trim(),
                getPassword: async () => pass.text || lookupPassword(),
                fingerprint: settings.get_string('cert-fingerprint'),
                onFingerprint: fp => settings.set_string('cert-fingerprint', fp),
            });
            try {
                const m = primaryModem(await client.getModems());
                test.subtitle = m
                    ? `OK – ${[m.operator, formatLabel(m)].filter(Boolean).join(' · ')}`
                    : 'OK – aber kein Modem gemeldet';
            } catch (e) {
                test.subtitle = `Fehler (${e.kind ?? 'unbekannt'}): ${e.message}`;
            } finally {
                client.destroy();
                btn.sensitive = true;
            }
        });
        test.add_suffix(btn);
        group.add(test);

        return group;
    }

    _certGroup(settings) {
        const group = new Adw.PreferencesGroup({
            title: 'Zertifikat',
            description: 'Selbstsignierte Zertifikate werden beim ersten Verbinden gepinnt (Trust on First Use). ' +
                'Ändert sich das Zertifikat, wird die Verbindung blockiert.',
        });
        const row = new Adw.ActionRow({title: 'SHA-256-Fingerprint', subtitle_selectable: true});
        row.add_css_class('property');
        const update = () => {
            const fp = settings.get_string('cert-fingerprint');
            row.subtitle = fp || 'noch keiner gespeichert';
        };
        update();
        settings.connect('changed::cert-fingerprint', update);

        const reset = new Gtk.Button({label: 'Vergessen', valign: Gtk.Align.CENTER});
        reset.add_css_class('destructive-action');
        reset.connect('clicked', () => settings.set_string('cert-fingerprint', ''));
        row.add_suffix(reset);
        group.add(row);
        return group;
    }

    _displayGroup(settings) {
        const group = new Adw.PreferencesGroup({title: 'Anzeige in der Leiste'});
        for (const [key, title] of [
            ['show-operator', 'Betreiber'],
            ['show-net-type', 'Netztyp (5G/4G/3G)'],
            ['show-band', 'Band'],
            ['show-signal', 'Signalwert'],
        ]) {
            const sw = new Adw.SwitchRow({title});
            settings.bind(key, sw, 'active', Gio.SettingsBindFlags.DEFAULT);
            group.add(sw);
        }

        const combo = new Adw.ComboRow({
            title: 'Signalwert',
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
        return group;
    }

    _toast(widget, title) {
        widget.get_root()?.add_toast?.(new Adw.Toast({title}));
    }
}
