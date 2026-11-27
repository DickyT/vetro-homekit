'use strict';
// Which input Home shows as current, for different foreground apps and sources.
const { buildTelevision } = require('../homekit/television');

const tv = { key: () => Promise.resolve(), launch: () => Promise.resolve() };
const base = [
  { id: 1, key: 'home', kind: 'home', name: 'TV' },
  { id: 4, key: 'hdmi2', kind: 'hdmi', hdmi: 2, name: 'HDMI 2' },
  { id: 11, key: 'app:Netflix.app', kind: 'app', appId: 'Netflix.app', name: 'Netflix' },
];
const ids = (th) => {
  for (const sv of th.accessory.services || []) {
    for (const c of sv.chars || sv.characteristics || []) if (c.type === 'E7') return c;
  }
  return null;
};

function run(inputs, state) {
  const th = buildTelevision({
    name: 'TV', model: 'm', serial: 's', firmware: '1', inputs, tv, log: () => {},
    onRename: () => true, onVisibility: () => {}, onPowerOff: () => {},
  });
  th.applyState(state);
  const c = ids(th);
  if (!c) throw new Error('ActiveIdentifier characteristic not found');
  return c.value;
}

const withTv = base.concat([{ id: 2, key: 'tv', kind: 'tv', name: 'Live TV' }]);
const withAirPlay = base.concat([{ id: 7, key: 'airplay', kind: 'airplay', name: 'AirPlay' }]);
const cases = [
  ['home screen, HDMI2 source', base, { foreground: 'APLauncher.Home', source: 'HDMI2' }, 1],
  ['viewer on HDMI2', base, { foreground: 'org.tizen.tv-viewer', source: 'HDMI2' }, 4],
  ['viewer on HDMI3 (not synced)', base, { foreground: 'org.tizen.tv-viewer', source: 'HDMI3' }, 1],
  ['Alexa (not synced) over HDMI2', base, { foreground: 'com.amazon.alexa', source: 'HDMI2' }, 1],
  ['Netflix', base, { foreground: 'Netflix.app', source: 'HDMI2' }, 11],
  ['unknown foreground, HDMI2', base, { foreground: '', source: 'HDMI2' }, 4],
  ['viewer on tuner, Live TV not synced', base, { foreground: 'org.tizen.tv-viewer', source: 'TV' }, 1],
  ['viewer on tuner, Live TV synced', withTv, { foreground: 'org.tizen.tv-viewer', source: 'TV' }, 2],
  ['AirPlay in front, synced', withAirPlay, { foreground: 'com.samsung.tv.airplay-app-2', source: 'HDMI2' }, 7],
  ['AirPlay in front, not synced', base, { foreground: 'com.samsung.tv.airplay-app-2', source: 'HDMI2' }, 1],
];

let failed = 0;
for (const [label, inputs, state, want] of cases) {
  let got;
  try { got = run(inputs, state); } catch (e) { got = 'error: ' + e.message; }
  const ok = got === want;
  if (!ok) failed++;
  console.log((ok ? 'PASS ' : 'FAIL ') + label + ' -> ' + got + (ok ? '' : ' (want ' + want + ')'));
}
console.log(failed ? failed + ' FAILED' : 'ALL PASS');
process.exit(failed ? 1 : 0);
