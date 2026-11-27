'use strict';
// What Home is told about power around a power key: no flicker from state
// reads that still show the old state, and the TV's own state wins in the end.
//   node test/power-hold-test.js
const { buildTelevision } = require('../homekit/television');

const realNow = Date.now;
let offset = 0;
Date.now = () => realNow() + offset;

function make() {
  const th = buildTelevision({
    name: 'TV', model: 'm', serial: 's', firmware: '1',
    inputs: [{ id: 1, key: 'home', kind: 'home', name: 'TV' }],
    tv: { key: () => Promise.resolve(), launch: () => Promise.resolve() }, log: () => {},
    onRename: () => true, onVisibility: () => {}, onPowerOff: () => {}, onPowerOn: () => {},
  });
  const power = th.accessory.characteristic(1, th.relayInfo.power);
  const seen = [];
  th.accessory.on('change', (c) => { if (c.iid === power.iid) seen.push(c.value); });
  return { th, power, seen };
}
const ON = { pmState: 1, foreground: 'APLauncher.Home' };
const OFF = { pmState: 4, foreground: 'APLauncher.Home' };
const results = [];
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  results.push(ok);
  console.log((ok ? 'ok   ' : 'FAIL ') + name + ': Home was told ' + JSON.stringify(got) + (ok ? '' : ', expected ' + JSON.stringify(want)));
};

(async () => {
  let t = make();
  t.th.applyState(ON);
  await t.th.accessory.write(t.power, 0, null); // Home turns it off
  t.th.applyState(ON); // the TV has not followed yet
  t.th.applyState(ON);
  t.th.applyState(OFF); // now it has
  check('off from Home, reads still showing on', t.seen, [0]);

  t = make();
  t.th.applyState(ON);
  t.th.setActive(false); // the remote: the watcher reports standby
  t.th.applyState(ON); // a read that began before it
  t.th.applyState(OFF);
  check('off from the remote, one stale read', t.seen, [0]);

  t = make();
  t.th.applyState(OFF);
  t.seen.length = 0;
  await t.th.accessory.write(t.power, 1, null); // Home turns it on from low power
  t.th.applyState(OFF); // not lit yet
  t.th.applyState(ON);
  check('on from Home, a read still showing off', t.seen, [1]);

  t = make();
  t.th.applyState(ON);
  await t.th.accessory.write(t.power, 0, null);
  t.th.applyState(ON);
  offset += 13000; // the power key did nothing: after the hold the TV's state wins
  t.th.applyState(ON);
  check('off from Home that the TV ignored', t.seen, [0, 1]);

  t = make();
  t.th.applyState(ON);
  await t.th.accessory.write(t.power, 0, null);
  t.th.applyState(OFF); // followed
  t.th.applyState(ON); // and turned on again at once (the remote)
  check('off, then really on again right after', t.seen, [0, 1]);

  process.exit(results.every(Boolean) ? 0 : 1);
})();
