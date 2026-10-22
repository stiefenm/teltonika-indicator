// gjs -m test/client-test.js BASEURL [EXPECT_FINGERPRINT]
// Läuft gegen test/mock_router.py (siehe test/run.sh).
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';
import System from 'system';
import {RouterClient} from '../lib/client.js';
import {isActiveSim} from '../lib/parse.js';

Gio._promisify(Soup.Session.prototype, 'send_and_read_async');

const [base, expectFp] = ARGV;
let failed = 0;
const check = (cond, what, extra = '') => {
    if (!cond)
        failed++;
    print(`${cond ? 'ok  ' : 'FAIL'} ${what} ${cond ? '' : extra}`);
};

async function send(method, path) {
    const s = new Soup.Session();
    const msg = Soup.Message.new(method, `${base}${path}`);
    msg.connect('accept-certificate', () => true);
    const bytes = await s.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, null);
    return JSON.parse(new TextDecoder().decode(bytes.get_data()));
}
const post = path => send('POST', path);

async function expectError(promise, kind, what) {
    try {
        await promise;
        check(false, what, 'no error');
    } catch (e) {
        check(e.kind === kind, what, `${e.kind} ${e.message}`);
        return e;
    }
    return null;
}

async function main() {
    // Zuerst: glib-networking cached TLS-Sessions prozessweit, eine Resumption
    // löst kein accept-certificate aus.
    if (base.startsWith('https')) {
        const mism = new RouterClient({
            host: base, username: 'monitor', getPassword: async () => 'secret',
            fingerprint: 'AA:BB',
        });
        try {
            await mism.getModems();
            check(false, 'pin mismatch rejected');
        } catch (e) {
            check(e.kind === 'cert' && e.fingerprint === expectFp, 'pin mismatch → cert', `${e.kind} ${e.message}`);
        }

        // Unbekanntes Zertifikat: abgelehnt, bevor das Passwort gesendet wird
        const unknown = new RouterClient({host: base, username: 'monitor', getPassword: async () => 'secret'});
        const e = await expectError(unknown.getModems(), 'untrusted', 'unpinned cert → untrusted');
        check(e?.fingerprint === expectFp, 'untrusted reports fingerprint', e?.fingerprint);
        // Erst jetzt eine akzeptierte Verbindung (frischer Mock: bisher kein Login)
        check((await send('GET', '/_test/logins')).logins === 0, 'no login sent to unpinned host');
    }

    const c = new RouterClient({
        host: base, username: 'monitor', getPassword: async () => 'secret', fingerprint: expectFp ?? '',
    });
    const modems = await c.getModems();
    check(modems[0]?.operator === 'Telekom.de', 'getModems');

    await post('/_test/expire');
    const again = await c.getModems();
    check(again.length === 2, 're-login after 401');
    await expectError(c.get('/_test/big'), 'parse', 'oversized response → parse');
    await expectError(c.get('/_test/redirect'), 'config', 'redirect not followed → config');
    c.destroy();

    const slow = new RouterClient({
        host: base, username: 'monitor', getPassword: async () => 'secret', fingerprint: expectFp ?? '', maxTime: 2,
    });
    await expectError(slow.get('/_test/slow'), 'network', 'slow drip → total timeout');
    slow.destroy();

    const nopw = new RouterClient({host: base, username: 'monitor', getPassword: async () => null});
    await expectError(nopw.getModems(), 'password', 'no password → password');

    const fp = expectFp ?? '';
    const bad = new RouterClient({host: base, username: 'monitor', getPassword: async () => 'wrong', fingerprint: fp});
    try {
        await bad.getModems();
        check(false, 'wrong password rejected');
    } catch (e) {
        check(e.kind === 'auth', 'wrong password → auth', e.kind);
    }

    const rw = new RouterClient({host: base, username: 'monitor', getPassword: async () => 'secret', fingerprint: fp});
    const cards = await rw.getSimCards();
    check(cards.length === 3 && cards[2].esimProfile === '1', 'getSimCards', JSON.stringify(cards));
    const esim = cards.find(c => c.position === 3);
    // switch_sim: 1 → 2 (leer) → 3 (eSIM) → 1
    const seq = [];
    for (let i = 0; i < 3; i++) {
        await rw.switchSim('2-1');
        const m = (await rw.getModems())[0];
        seq.push(`${m.activeSim}${m.netType ? '' : '!'}`);
    }
    check(seq.join(',') === '2!,3,1', 'switchSim cycles incl. empty slot', seq.join(','));
    let m = (await rw.getModems())[0];
    check(isActiveSim(m, cards[0]), 'back on SIM 1');
    await rw.setDefaultSim(esim.id);
    m = (await rw.getModems())[0];
    check(m.activeSim === 1 && (await rw.getSimCards()).find(c => c.primary)?.position === 3,
        'setDefaultSim keeps active SIM', `${m.activeSim}`);
    const limits = await rw.getDataLimits();
    check(limits.length === 3 && limits[2].position === 3 && limits[2].esimProfile === '1',
        'getDataLimits maps eSIM interface', JSON.stringify(limits));
    try {
        await rw.clearDataLimit('mob1s3a1e2');
        check(false, 'clear inactive interface rejected');
    } catch (e) {
        check(e.kind === 'http', 'clear inactive interface → http', `${e.kind} ${e.message}`);
    }
    await rw.clearDataLimit('mob1s1a1');
    check((await rw.getDataLimits())[0].used === 0, 'clearDataLimit resets active SIM');
    rw.destroy();

    const ro = new RouterClient({host: base, username: 'readonly', getPassword: async () => 'secret', fingerprint: fp});
    try {
        await ro.switchSim('2-1');
        check(false, 'read-only switch rejected');
    } catch (e) {
        check(e.kind === 'forbidden', 'read-only switch → forbidden', `${e.kind} ${e.message}`);
    }
    check((await ro.getModems()).length === 2, 'read-only can still read');
    const roLimits = await ro.getDataLimits();
    check(roLimits[2].position === 3 && roLimits[2].esimProfile === null, 'limits without interfaces/config');
    try {
        await ro.clearDataLimit('mob1s1a1');
        check(false, 'read-only clear rejected');
    } catch (e) {
        check(e.kind === 'forbidden', 'read-only clear → forbidden', e.kind);
    }

    const off = new RouterClient({host: 'http://127.0.0.1:1', username: 'x', getPassword: async () => 'x'});
    try {
        await off.getModems();
        check(false, 'offline');
    } catch (e) {
        check(e.kind === 'network', 'unreachable → network', e.kind);
    }
}

const loop = new GLib.MainLoop(null, false);
main().catch(e => {
    failed++;
    print(`FAIL exception: ${e.message}\n${e.stack}`);
}).finally(() => loop.quit());
loop.run();
print(failed ? `\n${failed} FAILED` : '\nall passed');
if (failed)
    System.exit(1);
