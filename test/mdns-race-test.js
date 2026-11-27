'use strict';
// Checks that hap/mdns.js never leaves a registration behind: advertise, then
// update() at once and again mid-registration (what start-up and quick
// pairing changes do), then stop(). Uses macOS's mDNSResponder, which speaks
// the same protocol as the TV's mdnsd. Run on a Mac: node test/mdns-race-test.js
process.env.HK_MDNSD_SOCKET = process.env.HK_MDNSD_SOCKET || '/var/run/mDNSResponder';
const { execFile } = require('child_process');
const mdns = require('../homekit/hap/mdns');

const TYPE = '_hkrace' + process.pid % 1000 + '._tcp';
function browse() {
  return new Promise((resolve) => {
    const p = execFile('dns-sd', ['-B', TYPE, 'local.'], { timeout: 2500 }, (e, out) => {
      const live = new Map();
      for (const line of String(out).split('\n')) {
        const m = /\s(Add|Rmv)\s+\d+\s+\d+\s+\S+\s+\S+\s+(.+)$/.exec(line);
        if (!m) continue;
        const n = live.get(m[2]) || 0;
        live.set(m[2], m[1] === 'Add' ? n + 1 : n - 1);
      }
      resolve([...live].filter((x) => x[1] > 0).map((x) => x[0]));
    });
    p.on('error', () => resolve(null));
  });
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const logs = [];
  const ad = mdns.advertise({ name: 'HK Race Test', type: TYPE, port: 45678, txt: { a: '1' }, log: (m) => logs.push(m) });
  ad.update({ a: '2' });                 // while the first registration is in flight
  await wait(505);
  ad.update({ a: '3' });                 // while the re-registration is in flight
  await wait(1500);
  const during = await browse();
  ad.stop();
  await wait(800);
  const after = await browse();
  const ok = during && during.length === 1 && after && after.length === 0;
  console.log('published while running:', JSON.stringify(during));
  console.log('left after stop():      ', JSON.stringify(after));
  console.log('log:', logs.join(' | '));

  // An orphan left by an older copy of the module (no tag, so it is found by
  // its close handler): the next advertise() must close it.
  const orphan = await mdns.registerViaDaemon(process.env.HK_MDNSD_SOCKET,
    { name: 'HK Orphan', type: TYPE, port: 45679, txt: { a: '1' } }, () => {});
  delete orphan.sock[Symbol.for('vetro-homekit.mdns-socket')];
  await wait(800);
  const withOrphan = await browse();
  const logs2 = [];
  const ad2 = mdns.advertise({ name: 'HK Race Test', type: TYPE, port: 45678, txt: { a: '1' }, log: (m) => logs2.push(m) });
  await wait(1500);
  const reaped = await browse();
  ad2.stop();
  await wait(800);
  const ok2 = withOrphan && withOrphan.indexOf('HK Orphan') >= 0 && reaped && reaped.length === 1 && reaped[0] === 'HK Race Test';
  console.log('orphan before:          ', JSON.stringify(withOrphan));
  console.log('after next advertise(): ', JSON.stringify(reaped));
  console.log('log:', logs2.join(' | '));
  console.log(ok && ok2 ? 'PASS' : 'FAIL');
  process.exit(ok && ok2 ? 0 : 1);
})();
