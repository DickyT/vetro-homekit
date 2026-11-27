'use strict';
// The HomeKit Television accessory: services, characteristics and what each
// write does on the TV.

const Accessory = require('./hap/accessory').Accessory;
const HapError = require('./hap/accessory').HapError;
const KEEP = require('./hap/accessory').KEEP;
const Status = require('./hap/accessory').Status;

// Short forms of Apple-defined service and characteristic types.
const S = { Info: '3E', Protocol: 'A2', Television: 'D8', InputSource: 'D9', Speaker: '113' };
const C = {
  Identify: '14', Manufacturer: '20', Model: '21', Name: '23', SerialNumber: '30', FirmwareRevision: '52', Version: '37',
  Active: 'B0', ActiveIdentifier: 'E7', ConfiguredName: 'E3', SleepDiscoveryMode: 'E8', RemoteKey: 'E1',
  PowerModeSelection: 'DF', Identifier: 'E6', IsConfigured: 'D6', InputSourceType: 'DB',
  CurrentVisibilityState: '135', TargetVisibilityState: '134', Mute: '11A', VolumeControlType: 'E9', VolumeSelector: 'EA',
};

// HomeKit RemoteKey values -> TV key names.
const REMOTE_KEYS = {
  0: 'XF86AudioRewind', 1: 'XF86AudioForward', 2: 'XF86AudioNext', 3: 'XF86AudioPrev',
  4: 'Up', 5: 'Down', 6: 'Left', 7: 'Right', 8: 'Return', 9: 'XF86Back', 10: 'XF86Exit',
  11: 'XF86PlayBack', 15: 'XF86Info',
};

const INPUT_TYPE = { home: 1, tv: 2, hdmi: 3, airplay: 8, app: 10 };

// The TV's full-screen app while it shows an HDMI port or the tuner.
const VIEWER_APP = 'org.tizen.tv-viewer';
// Samsung's AirPlay receiver. It has no icon on the TV's home screen, but it
// can be brought to the front, and it is the full-screen app while it shows.
const AIRPLAY_APP = 'com.samsung.tv.airplay-app-2';

// Fixed inputs (1 home, 2 tuner, 3-6 HDMI, 7 AirPlay); apps get identifiers 11..30.
function baseInputs() {
  const list = [{ id: 1, kind: 'home', name: 'Home Screen' }, { id: 2, kind: 'tv', name: 'Live TV' }];
  for (let n = 1; n <= 4; n++) list.push({ id: 2 + n, kind: 'hdmi', hdmi: n, name: 'HDMI ' + n });
  list.push({ id: 7, kind: 'airplay', name: 'AirPlay' });
  return list;
}

function inputIid(id) { return 100 + id * 10; }

// opts: { name, model, serial, firmware, inputs: [{ id, key, kind, name, configuredName, hidden, hdmi?, appId? }],
//         tv, log, onRename(key|null, name) -> false to refuse, onVisibility(key, hidden), onPowerOff(),
//         onPowerOn() }
function buildTelevision(opts) {
  const tv = opts.tv;
  const log = opts.log;
  const acc = new Accessory();
  let lastState = null;

  const info = acc.addService(S.Info, 1);
  info.add(C.Identify, { format: 'bool', perms: ['pw'] }).handle(() => {
    log('identify requested');
    return tv.key('XF86Info');
  });
  info.add(C.Manufacturer, { format: 'string', perms: ['pr'], value: 'Samsung' });
  info.add(C.Model, { format: 'string', perms: ['pr'], value: opts.model });
  const infoName = info.add(C.Name, { format: 'string', perms: ['pr'], value: opts.name });
  info.add(C.SerialNumber, { format: 'string', perms: ['pr'], value: opts.serial });
  info.add(C.FirmwareRevision, { format: 'string', perms: ['pr'], value: opts.firmware });

  const proto = acc.addService(S.Protocol, 8);
  proto.add(C.Version, { format: 'string', perms: ['pr'], value: '1.1.0' });

  const tvs = acc.addService(S.Television, 10, { primary: true });
  const active = tvs.add(C.Active, { format: 'uint8', perms: ['pr', 'pw', 'ev'], value: 1, minValue: 0, maxValue: 1, validValues: [0, 1] });
  const activeId = tvs.add(C.ActiveIdentifier, { format: 'uint32', perms: ['pr', 'pw', 'ev'], value: opts.inputs.some((i) => i.id === 1) ? 1 : 0 });
  const tvName = tvs.add(C.ConfiguredName, { format: 'string', perms: ['pr', 'pw', 'ev'], value: opts.name });
  tvs.add(C.SleepDiscoveryMode, { format: 'uint8', perms: ['pr', 'ev'], value: 1, minValue: 0, maxValue: 1, validValues: [0, 1] });
  tvs.add(C.RemoteKey, { format: 'uint8', perms: ['pw'], minValue: 0, maxValue: 16, validValues: Object.keys(REMOTE_KEYS).map(Number) })
    .handle((v) => tv.key(REMOTE_KEYS[v]));
  tvs.add(C.PowerModeSelection, { format: 'uint8', perms: ['pw'], minValue: 0, maxValue: 1, validValues: [0, 1] })
    .handle(() => tv.key('XF86Menu'));

  // What Home was last told about power, and until when a state read that
  // says the opposite is not believed. The TV follows a power key a few
  // seconds later, and a read that began before a change can arrive after it;
  // without this, Home shows off, then on for a moment, then off again.
  // A read that agrees ends the hold; so does its time running out, after
  // which the TV's own state wins (a power key that did nothing).
  const HOLD_MS = 12000;
  let hold = null; // { on, until }
  function holdPower(on) { hold = { on, until: Date.now() + HOLD_MS }; }

  active.handle((v) => {
    holdPower(v === 1);
    if (v === 0) {
      // Answer HomeKit first: the TV suspends this process right after the key.
      log('power off requested');
      setTimeout(() => {
        opts.onPowerOff();
        tv.key('XF86PowerOff').catch((e) => log('power off failed: ' + e.message));
      }, 400);
    }
    // v === 1: this code runs, so the system is up. The TV is either lit
    // already or dark (low power, a dark wake); the caller sorts that out.
    if (v === 1 && opts.onPowerOn) opts.onPowerOn();
  });

  tvName.handle((v) => {
    if (opts.onRename(null, v) !== false) return undefined;
    // Home suggested a shortened name right after pairing: keep ours and send it back.
    setTimeout(() => acc.notify(tvName), 1500);
    return KEEP;
  });

  const speaker = acc.addService(S.Speaker, 30);
  const mute = speaker.add(C.Mute, { format: 'bool', perms: ['pr', 'pw', 'ev'], value: false });
  speaker.add(C.Active, { format: 'uint8', perms: ['pr', 'ev'], value: 1, minValue: 0, maxValue: 1, validValues: [0, 1] });
  speaker.add(C.VolumeControlType, { format: 'uint8', perms: ['pr', 'ev'], value: 1, minValue: 0, maxValue: 3, validValues: [0, 1, 2, 3] });
  speaker.add(C.VolumeSelector, { format: 'uint8', perms: ['pw'], minValue: 0, maxValue: 1, validValues: [0, 1] })
    .handle((v) => tv.key(v === 0 ? 'XF86AudioRaiseVolume' : 'XF86AudioLowerVolume'));
  mute.handle((v) => {
    if (lastState && lastState.muted === v) return undefined;
    return tv.key('XF86AudioMute').then(() => { if (lastState) lastState.muted = v; });
  });
  tvs.link(speaker);

  const byId = new Map();
  const nameChars = new Map();
  const plainNames = new Map();
  for (const input of opts.inputs) {
    byId.set(input.id, input);
    const s = acc.addService(S.InputSource, inputIid(input.id));
    const hidden = input.hidden ? 1 : 0;
    const configured = s.add(C.ConfiguredName, { format: 'string', perms: ['pr', 'pw', 'ev'], value: input.configuredName || input.name });
    configured.handle((v) => {
      if (opts.onRename(input.key, v) !== false) return undefined;
      // Home wrote its placeholder ("Input Source 3"): keep our name and send it back.
      setTimeout(() => acc.notify(configured), 1500);
      return KEEP;
    });
    nameChars.set(input.id, configured);
    // A controller that subscribes to a name gets its current value at once,
    // so names changed while it was away reach it.
    acc.pushOnSubscribe.add(configured.iid);
    s.add(C.InputSourceType, { format: 'uint8', perms: ['pr', 'ev'], value: INPUT_TYPE[input.kind], minValue: 0, maxValue: 10 });
    s.add(C.IsConfigured, { format: 'uint8', perms: ['pr', 'pw', 'ev'], value: 1, minValue: 0, maxValue: 1, validValues: [0, 1] });
    const current = s.add(C.CurrentVisibilityState, { format: 'uint8', perms: ['pr', 'ev'], value: hidden, minValue: 0, maxValue: 1, validValues: [0, 1] });
    s.add(C.TargetVisibilityState, { format: 'uint8', perms: ['pr', 'pw', 'ev'], value: hidden, minValue: 0, maxValue: 1, validValues: [0, 1] })
      .handle((v) => {
        opts.onVisibility(input.key, v === 1);
        acc.update(current, v);
      });
    s.add(C.Identifier, { format: 'uint32', perms: ['pr'], value: input.id });
    plainNames.set(input.id, s.add(C.Name, { format: 'string', perms: ['pr'], value: input.name }));
    tvs.link(s);
  }

  activeId.handle((id) => {
    const input = byId.get(id);
    if (!input) throw new HapError(Status.InvalidValue);
    log('switch to ' + input.name);
    if (input.kind === 'home') return tv.key('XF86Home');
    if (input.kind === 'tv') return tv.key('XF86DiscretSourceTV');
    if (input.kind === 'hdmi') return tv.key('XF86DiscretHDMI' + input.hdmi);
    if (input.kind === 'airplay') return tv.launch(AIRPLAY_APP);
    return tv.launch(input.appId);
  });

  acc.index();

  // A controller that subscribes to power or the current input gets the value
  // at once. After the relay stood in, a controller comes back holding the
  // relay's values; if the TV's own did not change, no event would correct them.
  acc.pushOnSubscribe.add(active.iid);
  acc.pushOnSubscribe.add(activeId.iid);

  // Which input is showing, from a tv.readState() result:
  //   an app that is in Home and in front -> that app (AirPlay counts as one);
  //   the source viewer in front (or the foreground app unknown) -> the
  //   active source, HDMI n or the tuner (Live TV), if that input is in Home;
  //   anything else (home screen, an app not in Home such as Alexa, a source
  //   not in Home) -> the TV itself (input 1), which is always in Home.
  function currentInput(state) {
    const fg = state.foreground || '';
    for (const input of opts.inputs) {
      if (input.kind === 'app' && input.appId === fg) return input.id;
      if (input.kind === 'airplay' && fg === AIRPLAY_APP) return input.id;
    }
    if (fg === '' || fg === VIEWER_APP) {
      const m = /^HDMI([1-4])$/.exec(state.source || '');
      const id = m ? 2 + Number(m[1]) : (state.source === 'TV' ? 2 : null);
      if (id !== null && byId.has(id)) return id;
    }
    return byId.has(1) ? 1 : 0;
  }

  function applyState(state) {
    lastState = state;
    // pmState 1 is on; 3 and 4 are the screen going off and standby, in the
    // seconds between the power key and the suspend.
    const on = !(state.pmState === 3 || state.pmState === 4);
    if (hold && on !== hold.on && Date.now() < hold.until) {
      // Not believed yet: see `hold`.
    } else {
      hold = null;
      acc.update(active, on ? 1 : 0);
    }
    if (typeof state.muted === 'boolean') acc.update(mute, state.muted);
    acc.update(activeId, currentInput(state));
  }

  function setActive(on) {
    holdPower(!!on);
    acc.update(active, on ? 1 : 0);
  }

  // Changes the name shown in Home for an input (pushed to controllers), and
  // the read-only default name to `plainName`. Returns whether the shown name changed.
  function setInputName(id, name, plainName) {
    const p = plainNames.get(id);
    if (p && plainName) p.value = plainName;
    const c = nameChars.get(id);
    if (!c || !name || c.value === name) return false;
    acc.update(c, name);
    return true;
  }

  // The TV's own name, from the settings page.
  function setName(name) {
    infoName.value = name;
    acc.update(tvName, name);
  }

  // For the relay: which characteristics are the power switch and the current
  // input, and the input to show while the TV is off. That is the input the TV
  // was on: it comes back on the same one, so Home is right the moment it wakes.
  const relayInfo = {
    power: active.iid,
    get input() { return { iid: activeId.iid, value: activeId.value }; },
  };

  return { accessory: acc, applyState, setActive, setInputName, setName, relayInfo };
}

module.exports = { buildTelevision, baseInputs };
