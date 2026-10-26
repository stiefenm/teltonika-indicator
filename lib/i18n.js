// Übersetzungen für lib/ (läuft in der Shell und in den Einstellungen). Die Textdomäne bindet
// ExtensionBase.initTranslations() an locale/; ohne Bindung (Tests) bleibt der englische Text.

import Gettext from 'gettext';

export const DOMAIN = 'teltonika-indicator';

export function _(text) {
    return Gettext.dgettext(DOMAIN, text);
}

// Platzhalter {name} ersetzen, z. B. fmt(_('Switch to {sim}'), {sim: 'SIM 2'})
export function fmt(text, values) {
    return text.replace(/\{(\w+)\}/g, (all, key) => key in values ? String(values[key]) : all);
}

// Nur für xgettext markieren; übersetzt wird beim Anzeigen (auf Modulebene ist die Domäne noch nicht gebunden)
export const N_ = text => text;
