// gjs -m test/client-test.js BASEURL [EXPECT_FINGERPRINT]
// Läuft gegen test/mock_router.py (siehe test/run.sh).
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';
import System from 'system';
import {RouterClient} from '../lib/client.js';

const [base, expectFp] = ARGV;
let failed = 0;
const check = (cond, what, extra = '') => {
    if (!cond)
        failed++;
    print(`${cond ? 'ok  ' : 'FAIL'} ${what} ${cond ? '' : extra}`);
};

async function post(path) {
    const s = new Soup.Session();
    const msg = Soup.Message.new('POST', `${base}${path}`);
    msg.connect('accept-certificate', () => true);
    await s.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, null);
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
    }

    let pinned = '';
    const c = new RouterClient({
        host: base, username: 'monitor', getPassword: async () => 'secret',
        onFingerprint: fp => {
            pinned = fp;
        },
    });
    const modems = await c.getModems();
    check(modems[0]?.operator === 'Telekom.de', 'getModems');
    if (base.startsWith('https'))
        check(pinned === expectFp, 'TOFU fingerprint pinned', `${pinned} != ${expectFp}`);

    await post('/_test/expire');
    const again = await c.getModems();
    check(again.length === 2, 're-login after 401');
    c.destroy();

    const bad = new RouterClient({host: base, username: 'monitor', getPassword: async () => 'wrong'});
    try {
        await bad.getModems();
        check(false, 'wrong password rejected');
    } catch (e) {
        check(e.kind === 'auth', 'wrong password → auth', e.kind);
    }

    const rw = new RouterClient({host: base, username: 'monitor', getPassword: async () => 'secret'});
    const before = (await rw.getModems())[0].activeSim;
    await rw.switchSim('2-1');
    const after = (await rw.getModems())[0].activeSim;
    check(before === 1 && after === 2, 'switchSim toggles active SIM', `${before} → ${after}`);
    await rw.switchSim('2-1'); // zurück
    rw.destroy();

    const ro = new RouterClient({host: base, username: 'readonly', getPassword: async () => 'secret'});
    try {
        await ro.switchSim('2-1');
        check(false, 'read-only switch rejected');
    } catch (e) {
        check(e.kind === 'forbidden', 'read-only switch → forbidden', `${e.kind} ${e.message}`);
    }
    check((await ro.getModems()).length === 2, 'read-only can still read');

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
