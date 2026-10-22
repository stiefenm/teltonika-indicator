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

// Echte RUTM30-Antworten (Firmware RUTM_R_00.07.24.6)
const r = P.primaryModem(P.parseModems(load('rutm30_modems_status.json')));
eq(P.formatLabel(r), '5G B20+B7+n78 \u221292 dBm', 'RUTM30 label');
eq([r.operator, r.activeSim, r.simCount, r.temperature], ['MEDIONmobile', 1, 3, 41], 'RUTM30 fields');
const cards = P.parseSimCards(load('rutm30_sim_cards_status.json'));
eq(cards.map(c => [c.position, c.esimProfile, c.primary]), [[1, null, false], [2, null, false], [3, '1', true]], 'RUTM30 sim cards');
eq(cards.map(P.simLabel), ['SIM 1', 'SIM 2', 'SIM 3 (eSIM 1)'], 'sim labels');
eq(P.simLabel({...cards[0], operator: 'Telekom'}), 'SIM 1 (Telekom)', 'sim label operator');
eq(P.simLabel({...cards[2], operator: 'MEDIONmobile'}), 'SIM 3 (eSIM 1, MEDIONmobile)', 'esim label operator');
eq([P.simKey(r.activeSim, r.esimProfile), P.simKey(cards[2].position, cards[2].esimProfile)], ['1/', '3/1'], 'sim keys');
eq(cards.map(c => P.isActiveSim(r, c)), [true, false, false], 'active SIM 1');
eq(P.isActiveSim({activeSim: 3, esimProfile: '1'}, cards[2]), true, 'active eSIM profile 1');
eq(P.isActiveSim({activeSim: 3, esimProfile: '2'}, cards[2]), false, 'other eSIM profile');
eq(P.normalizeModem({active_sim: 3, esim_profile: '1'}).esimProfile, '1', 'modem esim_profile');

const ifaces = P.parseMobileInterfaces(load('rutm30_interfaces_config.json'));
eq(ifaces.mob1s3a1e2, {modem: '2-1', position: 3, esimProfile: '1'}, 'eSIM interface mapping');
eq(ifaces.lan, undefined, 'non-mobile interface ignored');
const limits = P.parseDataLimits(load('rutm30_data_limit_status.json'), ifaces);
eq(limits.map(l => [l.interface, l.position, l.esimProfile, l.enabled]),
    [['mob1s1a1', 1, null, true], ['mob1s2a1', 2, null, false], ['mob1s3a1e2', 3, '1', true]], 'data limits');
eq(P.dataLimitFor(limits, '2-1', {position: r.activeSim, esimProfile: r.esimProfile})?.interface, 'mob1s1a1', 'limit of active SIM 1');
eq(P.dataLimitFor(limits, '2-1', cards[2])?.interface, 'mob1s3a1e2', 'limit of eSIM card');
eq(P.dataLimitFor(limits, '2-1', cards[1]), null, 'SIM 2 without limit');
eq(P.dataLimitFor(limits, '2-1', {position: 3, esimProfile: '2'}), null, 'other eSIM profile has no limit');
eq(P.formatDataLimit(limits[0]), '134.9 MB / 7.3 GB (1 %)', 'format limit');
eq(P.formatDataLimit(limits[2]), '29.1 GB / 30.0 GB (96 %)', 'format eSIM limit');
eq(limits.map(l => P.dataLimitLevel(l)), [0, 0, 1], 'limit levels');
eq(P.dataLimitLevel({...limits[2], used: limits[2].limit}), 2, 'limit exhausted');
const half = {enabled: true, used: 85, limit: 100};
eq([P.dataLimitLevel(half), P.dataLimitLevel(half, 90), P.dataLimitLevel(half, 0)], [1, 0, 0], 'warn threshold');
eq(P.parseDataLimits(load('rutm30_data_limit_status.json'))[2].position, 3, 'slot from name without config');

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
