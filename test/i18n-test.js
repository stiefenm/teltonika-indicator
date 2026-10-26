// LANGUAGE=… gjs -m test/i18n-test.js LOCALEDIR ERWARTET
// Prüft, dass lib/i18n.js die Textdomäne nutzt (wie nach initTranslations() in der Shell).
import GLib from 'gi://GLib';
import Gettext from 'gettext';
import System from 'system';
import {DOMAIN, _, fmt} from '../lib/i18n.js';

const [localeDir, expected] = ARGV;
Gettext.bindtextdomain(DOMAIN, localeDir);
const got = fmt(_('Switch to {sim}'), {sim: 'SIM 2'});
const ok = got === expected;
print(`${ok ? 'ok  ' : 'FAIL'} LANGUAGE=${GLib.getenv('LANGUAGE')}: ${got}${ok ? '' : ` (want ${expected})`}`);
if (!ok)
    System.exit(1);
