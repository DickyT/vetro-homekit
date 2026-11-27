'use strict';
// End-to-end test of the relay on this machine, with a made-up TV identity:
// finds the relay through Bonjour, checks the secret, hands a Television
// accessory over, talks to the stand-in as a paired HomeKit controller
// (test/controller.js), and takes everything back.
// Sends a magic packet for the made-up MAC aa:bb:cc:dd:ee:01 on the LAN; nothing answers to it.
//   node test/relay-test.js

const path = require('path');
const fs = require('fs');
const { spawn, execFileSync } = require('child_process');
const hc = require('../homekit/hap/crypto');
const link = require('../homekit/relaylink');
const { buildTelevision } = require('../homekit/television');

const SECRET = 'test-secret-' + Math.random().toString(36).slice(2);
const PORT = 18125;
const HAP = 18126;
const target = { ip: '127.0.0.1', port: PORT };
const pairingFile = path.join(__dirname, '.pairing-127.0.0.1-' + HAP + '.json');
const results = [];
const check = (name, ok, detail) => { results.push(ok); console.log((ok ? 'ok   ' : 'FAIL ') + name + (detail ? ': ' + detail : '')); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const ctl = (...args) => { try { return execFileSync('node', [path.join(__dirname, 'controller.js'), '127.0.0.1', String(HAP)].concat(args), { encoding: 'utf8' }); } catch (e) { return 'ERR ' + (e.stdout || '') + (e.stderr || ''); } };

(async () => {
  const relay = spawn('node', [path.join(__dirname, '..', 'relay', 'relay.js')], {
    env: Object.assign({}, process.env, { RELAY_SECRET: SECRET, RELAY_PORT: String(PORT), RELAY_HAP_PORT: String(HAP), RELAY_NAME: 'Test Relay' }),
  });
  let out = '';
  relay.stdout.on('data', (d) => { out += d; });
  relay.stderr.on('data', (d) => { out += d; });
  try {
    await wait(1500);
    const found = await link.find(1200, PORT);
    check('found with a broadcast', found.some((f) => f.name === 'Test Relay' && f.port === PORT), JSON.stringify(found.map((f) => f.name + '@' + f.ip + ':' + f.port)));
    const inf = await link.info(target);
    check('/info', inf.service === 'vetro-homekit-relay' && inf.standingIn === false);

    let wrong = null;
    try { await link.call(target, link.key('not the secret'), '/hello', {}); } catch (e) { wrong = e.code; }
    check('a wrong secret is refused', wrong === 'secret');
    const hello = await link.call(target, link.key(SECRET), '/hello', {});
    check('the right secret is accepted', hello.ok === true);

    // A TV to hand over: accessory, keys, one paired controller.
    const tv = buildTelevision({
      name: 'Test TV', model: 'm', serial: 's', firmware: '1',
      inputs: [{ id: 1, key: 'home', kind: 'home', name: 'TV', configuredName: 'TV' }, { id: 4, key: 'hdmi2', kind: 'hdmi', hdmi: 2, name: 'HDMI 2', configuredName: 'Apple TV' }],
      tv: { key: () => Promise.resolve(), launch: () => Promise.resolve() }, log: () => {},
      onRename: () => true, onVisibility: () => {}, onPowerOff: () => {},
    });
    tv.applyState({ pmState: 1, foreground: 'org.tizen.tv-viewer', source: 'HDMI2', muted: false });
    const accKeys = hc.edKeyPair();
    const me = hc.edKeyPair();
    const myId = 'TEST-CONTROLLER';
    const deviceId = 'AA:BB:CC:00:00:01';
    fs.writeFileSync(pairingFile, JSON.stringify({ id: myId, ltsk: me.priv.toString('hex'), ltpk: me.pub.toString('hex'), accId: deviceId, accLtpk: accKeys.pub.toString('hex') }), { mode: 0o600 });
    const handover = {
      tv: { name: 'Test TV', mac: 'aa:bb:cc:dd:ee:01', ip: '127.0.0.1', port: 1 },
      identity: { deviceId, ltsk: accKeys.priv.toString('hex'), ltpk: accKeys.pub.toString('hex'), pairings: { [myId]: { pub: me.pub.toString('hex'), admin: true } } },
      txt: { 'c#': '1', ff: '0', id: deviceId, md: 'Vetro HomeKit', pv: '1.1', 's#': '1', sf: '0', ci: '31' },
      accessories: tv.accessory.toJSON(),
      power: tv.relayInfo.power,
      input: tv.relayInfo.input,
    };
    const h = await link.call(target, link.key(SECRET), '/handover', handover);
    check('handover accepted', h.ok === true);
    check('/info says standing in', (await link.info(target)).standingIn === true);
    await wait(500);

    const p = handover.power;
    const i = handover.input.iid;
    const got = ctl('get', '1.' + p, '1.' + i);
    // The TV was on HDMI 2 (input 4) when it was handed over: the relay shows the same.
    check('a paired controller reads power off and the input the TV was on', got.indexOf('"iid":' + p + ',"value":0') >= 0 && got.indexOf('"iid":' + i + ',"value":4') >= 0, got.trim().slice(0, 160));
    const shape = ctl('accessories');
    check('the accessory database is the TV\'s', shape.split('\n').filter((l) => /^service /.test(l)).length === tv.accessory.toJSON()[0].services.length);
    const nameIid = tv.accessory.toJSON()[0].services.find((s) => s.type === 'D9' && s.iid === 140).characteristics.find((c) => c.type === 'E3').iid;
    const set = ctl('set', '1.' + nameIid + '=Projector', '1.' + i + '=1', '1.' + p + '=1');
    check('writes are accepted', /^204|^207|^200/.test(set.trim()), set.trim().slice(0, 100));
    await wait(300);
    check('power on sent a magic packet', /sending magic packets to aa:bb:cc:dd:ee:01/.test(out));

    const r = await link.call(target, link.key(SECRET), '/release', {});
    check('release reports the wake and the writes', r.woke === true && r.writes.some((w) => w.iid === nameIid && w.value === 'Projector') && r.writes.some((w) => w.iid === i && w.value === 1) && !r.writes.some((w) => w.iid === p), JSON.stringify(r.writes));
    check('release reports no pairing change', r.pairings === null);
    check('/info says not standing in', (await link.info(target)).standingIn === false);
    const after = ctl('get', '1.' + p);
    check('the stand-in is gone', /^ERR|FAILED/.test(after.trim()));
  } catch (e) {
    check('no exception', false, e.stack || e.message);
  } finally {
    try { fs.unlinkSync(pairingFile); } catch (e) { /* none */ }
    relay.kill();
    await wait(400);
    if (!results.every(Boolean)) console.log('--- relay output\n' + out);
    process.exit(results.every(Boolean) ? 0 : 1);
  }
})();
