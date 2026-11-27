'use strict';
// The plugin's side of Relay mode against a real relay on this machine: the
// shard (real HAP stack and accessory, stubbed TV and Bonjour) hands over on
// standby, a paired controller turns the TV on and picks an input through
// the relay, and the shard takes HomeKit back and replays the input.
// The relay sends magic packets for this machine's own MAC; harmless.
//   node test/relay-plugin-test.js

const path = require('path');
const fs = require('fs');
const { spawn, execFileSync } = require('child_process');
const root = path.join(__dirname, '..', 'homekit');
const hc = require(path.join(root, 'hap', 'crypto'));
const link = require(path.join(root, 'relaylink'));

const SECRET = 'plugin-test-' + Math.random().toString(36).slice(2);
const PORT = 18135;
const HAP = 18136;
const pairingFile = path.join(__dirname, '.pairing-127.0.0.1-' + HAP + '.json');
const results = [];
const check = (name, ok, detail) => { results.push(ok); console.log((ok ? 'ok   ' : 'FAIL ') + name + (detail ? ': ' + detail : '')); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const ctl = (...args) => { try { return execFileSync('node', [path.join(__dirname, 'controller.js'), '127.0.0.1', String(HAP)].concat(args), { encoding: 'utf8' }); } catch (e) { return 'ERR ' + (e.stdout || '') + (e.stderr || ''); } };

function stub(file, exports) {
  const p = require.resolve(path.join(root, file));
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
}
const keys = [];
let lit = true;
stub('hap/mdns', { advertise: () => ({ update() {}, restart() {}, stop() {}, status: () => null }) });
stub('tv', { Tv: class {
  key(name) { keys.push(name); return Promise.resolve({}); }
  launch() { return Promise.resolve({}); }
  readState() { return Promise.resolve({ pmState: lit ? 1 : 4, power: lit ? 'lcdon' : 'standby', screen: lit ? 1 : 0, foreground: 'APLauncher.Home', source: 'HDMI2', muted: false }); }
  hdmi() { return Promise.reject(new Error('not read in this test')); }
}, parseState: () => ({}) });

const acc = hc.edKeyPair();
const me = hc.edKeyPair();
const deviceId = 'AA:BB:CC:00:00:02';
let cfg = {
  deviceId, ltsk: acc.priv.toString('hex'), ltpk: acc.pub.toString('hex'), setupCode: '000-00-001', port: 18137, name: 'Test TV',
  pairings: { CTRL: { pub: me.pub.toString('hex'), admin: true } }, schema: 4, apps: [], sync: {}, custom: {}, hidden: {}, ports: {}, configNumber: 3,
  offMode: 'relay', deepSleepMin: 0, relay: { secret: SECRET, address: '127.0.0.1:' + PORT },
};
const ctx = {
  dir: root,
  config: { get: () => cfg, set(v) { cfg = v; } },
  execute: () => Promise.resolve({ stdout: 'armed scope alive', stderr: '' }),
};
const state = (shard) => { let out = null; shard.route({ method: 'GET' }, { writeHead() {}, end(s) { out = JSON.parse(s); } }, 'state'); return out; };
const post = (shard, sub) => shard.route({ method: 'POST' }, { writeHead() {}, end() {} }, sub);

(async () => {
  const relay = spawn('node', [path.join(__dirname, '..', 'relay', 'relay.js')], {
    env: Object.assign({}, process.env, { RELAY_SECRET: SECRET, RELAY_PORT: String(PORT), RELAY_HAP_PORT: String(HAP), RELAY_NAME: 'Plugin Test Relay' }),
  });
  let out = '';
  relay.stdout.on('data', (d) => { out += d; });
  relay.stderr.on('data', (d) => { out += d; });
  let shard = null;
  try {
    await wait(1200);
    shard = require(root)(ctx);
    shard.start();
    await wait(1500);
    let st = state(shard);
    check('the settings page sees the relay', st.relay.status.state === 'ok' && st.relay.handedOver === false, JSON.stringify(st.relay.status));
    check('the state never holds the secret', JSON.stringify(st).indexOf(SECRET) < 0);

    lit = false;
    post(shard, 'standby');
    await wait(1500);
    st = state(shard);
    check('handed over on standby', st.relay.handedOver === true && (await link.info({ ip: '127.0.0.1', port: PORT })).standingIn === true, st.log.slice(-2).join(' | '));

    fs.writeFileSync(pairingFile, JSON.stringify({ id: 'CTRL', ltsk: me.priv.toString('hex'), ltpk: me.pub.toString('hex'), accId: deviceId, accLtpk: acc.pub.toString('hex') }), { mode: 0o600 });
    const got = ctl('get', '1.11', '1.12');
    check('the relay shows power off, input TV', got.indexOf('"iid":11,"value":0') >= 0 && got.indexOf('"iid":12,"value":1') >= 0, got.trim().slice(0, 120));
    const set = ctl('set', '1.12=4', '1.11=1');
    await wait(400);
    check('Home turns the TV on and picks HDMI 2 through the relay', /^204/.test(set.trim()) && /sending magic packets/.test(out), set.trim().slice(0, 60));

    // The TV wakes lit: the watcher reports it.
    lit = true;
    post(shard, 'power/lcdon/43');
    await wait(1500);
    st = state(shard);
    check('took HomeKit back', st.relay.handedOver === false && (await link.info({ ip: '127.0.0.1', port: PORT })).standingIn === false, st.log.slice(-2).join(' | '));
    check('the input is not switched before the TV has woken', keys.indexOf('XF86DiscretHDMI2') < 0);
    await wait(6000);
    check('the input chosen in Home is replayed', keys.indexOf('XF86DiscretHDMI2') >= 0, keys.join(','));

    // A cancelled power-off: no resume signal, the state poll sees the screen on.
    lit = false;
    post(shard, 'standby');
    await wait(1200);
    check('handed over again', state(shard).relay.handedOver === true);
    lit = true;
    await wait(14000);
    check('taken back when the screen is on without a resume signal', state(shard).relay.handedOver === false, state(shard).log.slice(-1)[0]);
  } catch (e) {
    check('no exception', false, e.stack || e.message);
  } finally {
    try { fs.unlinkSync(pairingFile); } catch (e) { /* none */ }
    try { if (shard) shard.stop(); } catch (e) { /* stopped */ }
    relay.kill();
    await wait(400);
    if (!results.every(Boolean)) console.log('--- relay output\n' + out);
    process.exit(results.every(Boolean) ? 0 : 1);
  }
})();
