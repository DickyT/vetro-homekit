'use strict';
// Unit test for powerOn() in homekit/index.js: when Home asks for the TV to
// be on, how many times the power key is pressed for each way the TV can
// answer. The shard runs with stubs for the HAP server, Bonjour, the TV and
// root commands; the TV's power state follows a script.
//   node test/poweron-test.js

const path = require('path');
const root = path.join(__dirname, '..', 'homekit');
const power = require(path.join(root, 'power'));

function stub(file, exports) {
  const p = require.resolve(path.join(root, file));
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
}

let script = () => 'lcdon'; // (ms since the first key press or null, presses so far) -> state
let presses = [];
let firstPress = null;
let television = null;

stub('hap/server', { HapServer: class {
  constructor() { this.server = { on() {} }; this.recent = []; }
  on() {}
  listen() { return Promise.resolve(50123); }
  close() {}
  controllerCount() { return 0; }
} });
stub('hap/mdns', { advertise: () => ({ update() {}, restart() {}, stop() {}, status: () => null }) });
stub('tv', { Tv: class {
  key(name) { if (firstPress === null) firstPress = Date.now(); presses.push(name); return Promise.resolve({}); }
  readState() { return Promise.resolve({ pmState: 1 }); }
  hdmi() { return Promise.resolve({}); }
} });
stub('television', { buildTelevision(opts) {
  television = opts;
  return { accessory: { toJSON: () => [{ services: [] }], write() {} }, applyState() {}, setActive() {}, setInputName() { return false; }, setName() {} };
} });

let cfg = {};
const ctx = {
  dir: root,
  config: { get: () => cfg, set(v) { cfg = v; } },
  execute(cmd) {
    if (cmd === power.STATE) {
      const st = script(firstPress === null ? null : Date.now() - firstPress, presses.length);
      return Promise.resolve({ stdout: "('" + st + "',)\n" });
    }
    return Promise.resolve({ stdout: 'armed scope alive', stderr: '' });
  },
};

const shard = require(root)(ctx);

async function run(name, fn, wantPresses, maxMs) {
  script = fn;
  presses = [];
  firstPress = null;
  const t0 = Date.now();
  television.onPowerOn(); // not awaited by its caller either; its last log line marks the end
  while (!done() && Date.now() - t0 < 20000) await new Promise((r) => setTimeout(r, 100));
  const ms = Date.now() - t0;
  const ok = presses.length === wantPresses && (!maxMs || ms <= maxMs);
  console.log((ok ? 'ok   ' : 'FAIL ') + name + ': ' + presses.length + ' presses in ' + ms + ' ms' + (ok ? '' : ' (want ' + wantPresses + (maxMs ? ' within ' + maxMs + ' ms' : '') + ')'));
  return ok;
}

// The shard's log is only reachable through its state route.
function logLines() {
  let out = null;
  const res = { writeHead() {}, end(s) { out = JSON.parse(s); } };
  shard.route({ method: 'GET' }, res, 'state');
  return out.log;
}
let seenLines = 0;
function done() {
  const l = logLines().slice(seenLines);
  const i = l.findIndex((x) => /already on|TV is on|after two presses|could not read|power on failed/.test(x));
  if (i < 0) return false;
  seenLines += i + 1;
  return true;
}

(async () => {
  shard.start();
  await new Promise((r) => setTimeout(r, 300));
  seenLines = logLines().length;
  const results = [];
  results.push(await run('already lit', () => 'lcdon', 0));
  results.push(await run('low power, lights after the press', (ms) => (ms === null ? 'lowpower' : 'lcdon'), 1, 2500));
  results.push(await run('standby, slow to light (2 s)', (ms) => (ms !== null && ms > 2000 ? 'lcdon' : 'standby'), 1, 4500));
  // The first press is swallowed as standby turns into low power 1 s later.
  results.push(await run('standby, press swallowed, low power 1 s later', (ms, n) => (ms === null ? 'standby' : n >= 2 ? 'lcdon' : ms < 1000 ? 'standby' : 'lowpower'), 2, 5000));
  results.push(await run('low power, never lights', () => 'lowpower', 2, 13000));
  shard.stop();
  process.exit(results.every(Boolean) ? 0 : 1);
})();
