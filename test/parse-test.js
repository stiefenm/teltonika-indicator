// gjs -m test/parse-test.js
import GLib from 'gi://GLib';
import System from 'system';
import * as P from '../lib/parse.js';

const dir = GLib.path_get_dirname(import.meta.url.replace('file://', ''));
const load = n => JSON.parse(new TextDecoder().decode(GLib.file_get_contents(`${dir}/fixtures/${n}`)[1]));

let failed = 0;
function eq(actual, expected, what) {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    if (!ok)
        failed++;
    print(`${ok ? 'ok  ' : 'FAIL'} ${what}${ok ? '' : `: got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`}`);
}

eq(P.num('−95 dBm'), -95, 'num unicode minus');
eq(P.num('12.4'), 12.4, 'num float');
eq(P.num('N/A'), null, 'num N/A');
eq(P.normalizeBaseUrl(' 192.168.1.1/ '), 'https://192.168.1.1', 'baseUrl default https');
eq(P.normalizeBaseUrl('http://r.lan'), 'http://r.lan', 'baseUrl keeps http');
eq(P.normalizeBaseUrl(''), null, 'baseUrl empty');

for (const [inp, out] of [['LTE B3', 'B3'], ['LTE_B20', 'B20'], ['B7', 'B7'], ['LTE BAND 1', 'B1'],
    ['5G N78', 'n78'], ['NR5G BAND 78', 'n78'], ['n28', 'n28'], ['WCDMA 2100', 'WCDMA 2100']])
    eq(P.shortBand(inp), out, `shortBand ${inp}`);

for (const [inp, out] of [['LTE', '4G'], ['5G-NSA', '5G'], ['5G-SA', '5G'], ['WCDMA', '3G'], ['HSPA+', '3G'], ['GSM', '2G'], ['', null]])
    eq(P.netTypeOf(inp), out, `netType ${inp}`);

const all = P.parseModems(load('modems_status.json'));
const m = P.primaryModem(all);
eq(m.id, '2-1', 'primary skips offline modem');
eq(m.bandShort, 'B3+B20+n78', 'CA bands deduplicated');
eq(m.temperature, 38, 'temperature');
eq([m.activeSim, m.simCount], [1, 2], 'SIM fields');
eq(all[1].offline, true, 'offline flag');
eq(P.normalizeModem({temperature: 390}).temperature, 39, 'temperature tenths');
eq(P.signalQuality(m), 2, 'quality rsrp -95');
eq(P.formatLabel(m), '5G B3+B20+n78 −95 dBm', 'label default');
eq(P.formatLabel(m, {metric: 'sinr', showBand: false}), '5G 9 dB', 'label sinr');
eq(P.formatBytes(m.rxBytes), '42.7 GB', 'bytes');
eq(P.netTypeOf('4G (LTE); VoLTE'), '4G', 'netType 4G (LTE); VoLTE');

const ms = P.parseModems(load('modems_status_5g_nsa.json'));
eq(ms.length, 2, 'two modems');
const p = P.primaryModem(ms);
eq(p.name, 'Primary', 'primary modem');
eq(p.bandShort, 'B1+n78', 'NSA bands');
eq(P.signalQuality(p), 4, 'quality excellent');
eq(P.signalQuality(ms[1]), -1, 'quality unknown');
eq(P.formatLabel(ms[1]), '', 'empty label without data');
eq(P.formatLabel({...p, rsrp: null}, {metric: 'rsrp'}), '5G B1+n78 −60 dBm', 'fallback rssi');

let threw = false;
try {
    P.parseModems({success: false});
} catch {
    threw = true;
}
eq(threw, true, 'success:false throws');

print(failed ? `\n${failed} FAILED` : '\nall passed');
if (failed)
    System.exit(1);
