'use strict';
// Vetro shard: makes the TV a native HomeKit Television accessory.
//
// Inputs. Every input has a key ("hdmi1".."hdmi4", "home", "tv", "airplay", "app:<appId>"),
// a HomeKit identifier (id), and:
//   synced     - whether it is in Home at all. The four HDMI ports are by
//                default; Home Screen, Live TV and apps are opt-in on the
//                settings page.
//   autoName   - the plugin's name: the device's HDMI-CEC name, "HDMI 2" for
//                a device without one, "HDMI 1 Unplugged" for an empty port.
//   customName - a name set on the settings page or in the Home app. It wins
//                until it is reverted, or a different device shows up on the port.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const hc = require('./hap/crypto');
const HapServer = require('./hap/server').HapServer;
const mdns = require('./hap/mdns');
const power = require('./power');
const link = require('./relaylink');
const os = require('os');
const Tv = require('./tv').Tv;
const television = require('./television');

const VERSION = '0.6.9';
const SCHEMA = 4;
const CATEGORY_TELEVISION = 31;
const POLL_MS = 10000;
const FAST_POLL_MS = 2000;
const HDMI_POLL_MS = parseInt(process.env.HK_HDMI_POLL_MS || '', 10) || 10000;
// What happens when the TV is turned off (see power.js), and the choices for
// how long it stays in low power before a full sleep (0: never).
const OFF_MODES = ['remote', 'lowpower', 'relay'];
const DEEP_SLEEP_MIN = [0, 15, 60];
const APP_ID_RE = /^[A-Za-z0-9_.-]{1,128}$/;
const INVALID_CODES = ['000-00-000', '111-11-111', '222-22-222', '333-33-333', '444-44-444', '555-55-555',
  '666-66-666', '777-77-777', '888-88-888', '999-99-999', '123-45-678', '876-54-321'];
// The name the Home app writes for inputs it thinks have none.
const PLACEHOLDER_RE = /^input source( \d+)?$/i;
// After a new pairing, Home may rename the TV to the tail of our name ("TV").
const PAIR_RENAME_MS = 120000;

function randomSetupCode() {
  for (;;) {
    const n = crypto.randomBytes(4).readUInt32BE(0) % 100000000;
    const d = ('00000000' + n).slice(-8);
    const code = d.slice(0, 3) + '-' + d.slice(3, 5) + '-' + d.slice(5);
    if (INVALID_CODES.indexOf(code) < 0) return code;
  }
}

function randomDeviceId() {
  return crypto.randomBytes(6).toString('hex').toUpperCase().match(/../g).join(':');
}

// HomeKit accepts names of letters, digits, spaces and apostrophes that start
// and end with a letter or digit.
function homeKitName(s, fallback) {
  const t = String(s || '').replace(/[^\p{L}\p{N}' ]+/gu, ' ').replace(/\s+/g, ' ').slice(0, 40)
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
  return t || fallback;
}

// True if `name` is a strict word-boundary suffix of `full` ("Samsung TV" -> "TV").
function isNameSuffix(full, name) {
  const f = String(full).toLowerCase();
  const n = String(name).trim().toLowerCase();
  return n.length > 0 && f.length > n.length + 1 && f.endsWith(n) && f.charAt(f.length - n.length - 1) === ' ';
}

function readJson(req, cb) {
  const chunks = [];
  let size = 0;
  req.on('data', (c) => {
    size += c.length;
    if (size > 65536) req.destroy();
    else chunks.push(c);
  });
  req.on('end', () => {
    let body = {};
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch (e) { body = null; }
    cb(body);
  });
  req.on('error', () => cb(null));
}

module.exports = function (ctx) {
  const logLines = [];
  let cfg = null;
  let hap = null;
  let ad = null;
  let tvModel = null;
  let tv = null;
  let pollTimer = null;
  let wakeTimer = null;
  let hdmiTimer = null;
  let hdmiPending = null;
  let lastTick = Date.now();
  let fastUntil = 0;
  let lastState = null;
  let lastStateError = null;
  let lastHdmi = null;
  let lastHdmiAt = 0;
  let lastHdmiError = null;
  // Per HDMI port: the last report applied, and a different one seen once
  // (a change is applied when it is read twice in a row).
  let appliedSig = {};
  let pendingSig = {};
  let startError = null;
  let running = false;
  let port = null;
  let page = null;
  let generation = 0;
  let watchTimer = null;
  let watchSig = '';
  let watcher = null; // { since } once the power watcher runs; { error } if it could not start
  let poweringOn = false;
  let powerSig = '';
  // Relay mode: whether the relay currently answers for the TV, since when,
  // the relay found last, what the settings page shows, and a queue so that
  // handing over and taking back never overlap.
  let handedOver = false;
  let handedAt = 0;
  let relayFound = null;
  let relayStatus = { state: 'unknown' };
  let relayKeyCache = null;
  let relayQueue = Promise.resolve();
  let relayTimer = null;
  let pairedAt = 0;

  function log(m) {
    const t = new Date().toISOString().slice(11, 19);
    logLines.push(t + ' ' + m);
    if (logLines.length > 150) logLines.shift();
  }

  function save() {
    try { ctx.config.set(cfg); } catch (e) { log('saving config failed: ' + e.message); }
  }

  function isPaired() {
    return !!cfg && Object.keys(cfg.pairings).length > 0;
  }

  // Forgets what the Home app set (its names and hidden inputs); names set on
  // the settings page stay.
  function forgetHomeChoices(c) {
    let changed = Object.keys(c.hidden).length > 0;
    c.hidden = {};
    for (const k of Object.keys(c.custom)) {
      if (c.custom[k].from === 'home') { delete c.custom[k]; changed = true; }
    }
    return changed;
  }

  function loadConfig() {
    const c = ctx.config.get() || {};
    let changed = false;
    if (!c.deviceId) { c.deviceId = randomDeviceId(); changed = true; }
    if (!c.ltsk || !c.ltpk) {
      const kp = hc.edKeyPair();
      c.ltsk = kp.priv.toString('hex');
      c.ltpk = kp.pub.toString('hex');
      changed = true;
    }
    if (!c.setupCode) { c.setupCode = randomSetupCode(); changed = true; }
    if (!c.port) { c.port = 50000 + (crypto.randomBytes(2).readUInt16BE(0) % 10000); changed = true; }
    if (!c.name) { c.name = 'Samsung TV'; changed = true; }
    // 0.4.1 and earlier had "turn on from Home" through a sleep proxy; that is gone.
    if ('wakeFromHome' in c) { delete c.wakeFromHome; changed = true; }
    if (OFF_MODES.indexOf(c.offMode) < 0) { c.offMode = 'remote'; changed = true; }
    if (DEEP_SLEEP_MIN.indexOf(c.deepSleepMin) < 0) { c.deepSleepMin = 0; changed = true; }
    if (!c.relay || typeof c.relay !== 'object') { c.relay = { secret: '', address: '' }; changed = true; }
    if (!c.pairings) { c.pairings = {}; changed = true; }
    if ((c.schema || 0) < SCHEMA) {
      // 0.2 kept names by numeric id and synced a fixed set of apps. Now apps
      // are opt-in and everything is keyed by input key.
      const idKey = { 1: 'home', 2: 'tv', 3: 'hdmi1', 4: 'hdmi2', 5: 'hdmi3', 6: 'hdmi4' };
      c.custom = {};
      for (const id of Object.keys(c.inputNames || {})) {
        const name = c.inputNames[id];
        if (idKey[id] && name && !PLACEHOLDER_RE.test(name)) c.custom[idKey[id]] = { name, from: 'home' };
      }
      delete c.inputNames;
      delete c.autoNames;
      delete c.detectedNames;
      c.apps = [];
      c.sync = {};
      c.hidden = {};
      c.ports = {};
      c.schema = SCHEMA;
      changed = true;
    }
    if (c.schema === 3) {
      // 0.3.0 kept the TV itself (Home Screen) out of Home by default, and the
      // settings page saved that default as an explicit choice.
      if (c.sync) delete c.sync.home;
      c.schema = SCHEMA;
      changed = true;
    }
    if (!c.apps) c.apps = [];
    if (!c.sync) c.sync = {};
    if (!c.custom) c.custom = {};
    if (!c.hidden) c.hidden = {};
    if (!c.ports) c.ports = {};
    if (!c.configNumber) c.configNumber = 1;
    // Not in any home: the next add starts from the plugin's names, all inputs shown.
    if (!Object.keys(c.pairings).length && forgetHomeChoices(c)) changed = true;
    cfg = c;
    if (changed) save();
  }

  // The store object the HAP server reads and writes.
  function store() {
    return {
      deviceId: cfg.deviceId,
      ltsk: Buffer.from(cfg.ltsk, 'hex'),
      ltpk: Buffer.from(cfg.ltpk, 'hex'),
      get pairings() { return cfg.pairings; },
      set pairings(v) { cfg.pairings = v; },
      save,
    };
  }

  function hdmiAutoName(n) {
    const p = cfg.ports[n];
    if (p && p.connected === false) return 'HDMI ' + n + ' Unplugged';
    if (p && p.connected && p.named && p.device) return homeKitName(p.device, 'HDMI ' + n);
    return 'HDMI ' + n;
  }

  // Every input, synced or not, in display order: HDMI 1-4, Home Screen, Live TV, AirPlay, apps.
  function allInputs() {
    const list = [];
    for (let n = 1; n <= 4; n++) list.push({ id: 2 + n, key: 'hdmi' + n, kind: 'hdmi', hdmi: n, autoName: hdmiAutoName(n) });
    // The TV itself: its home screen and anything not on another input.
    list.push({ id: 1, key: 'home', kind: 'home', autoName: 'TV' });
    list.push({ id: 2, key: 'tv', kind: 'tv', autoName: 'Live TV' });
    // Samsung's AirPlay receiver: not in the TV's app list (it has no icon), so it is a fixed input.
    list.push({ id: 7, key: 'airplay', kind: 'airplay', autoName: 'AirPlay' });
    for (const a of cfg.apps) {
      list.push({ id: a.id, key: 'app:' + a.appId, kind: 'app', appId: a.appId, autoName: homeKitName(a.name, 'App') });
    }
    const used = new Set();
    for (const i of list) {
      let name = i.autoName;
      for (let k = 2; used.has(name.toLowerCase()); k++) name = i.autoName + ' ' + k;
      used.add(name.toLowerCase());
      i.autoName = name;
      i.name = name; // the read-only default name in HomeKit
      const c = cfg.custom[i.key];
      i.customName = c ? c.name : null;
      i.customFrom = c ? c.from : null;
      i.configuredName = i.customName || i.autoName;
      // In Home by default: the HDMI ports, AirPlay and added apps. Live TV (the tuner) is opt-in.
      // The TV itself is always in Home: it is what Home shows when nothing else is on screen.
      i.synced = i.kind === 'home' ? true : (typeof cfg.sync[i.key] === 'boolean' ? cfg.sync[i.key] : i.kind !== 'tv');
      i.hidden = !!cfg.hidden[i.key];
    }
    return list;
  }

  function syncedInputs() {
    return allInputs().filter((i) => i.synced);
  }

  // What decides the accessory database's layout; a change needs a rebuild.
  function layoutKey() {
    return JSON.stringify(syncedInputs().map((i) => i.key));
  }

  function txt() {
    return {
      'c#': String(cfg.configNumber),
      ff: '0',
      id: cfg.deviceId,
      md: 'Vetro HomeKit',
      pv: '1.1',
      's#': '1',
      sf: isPaired() ? '0' : '1',
      ci: String(CATEGORY_TELEVISION),
    };
  }

  function nextConfigNumber() {
    cfg.configNumber = (cfg.configNumber % 65535) + 1;
  }

  // A structural fingerprint; when it changes HomeKit must re-read the accessory database.
  function bumpConfigNumber(acc) {
    const shape = JSON.stringify(acc.toJSON()[0].services.map((s) => [s.type, s.iid, s.characteristics.map((c) => [c.type, c.iid])]));
    const hash = crypto.createHash('sha256').update(shape).digest('hex').slice(0, 16);
    if (cfg.shapeHash !== hash) {
      if (cfg.shapeHash) nextConfigNumber();
      cfg.shapeHash = hash;
      save();
    }
  }

  // Sends changed input names to subscribed controllers. With `announce`, a
  // new configuration number also makes controllers that were not listening
  // re-read them. `renamed`: the TV's own name changed too.
  function pushNames(announce, renamed) {
    if (!tvModel) return;
    let changed = false;
    for (const i of syncedInputs()) {
      if (tvModel.setInputName(i.id, i.configuredName, i.name)) changed = true;
    }
    if (!(changed || renamed) || !announce) return;
    nextConfigNumber();
    save();
    if (ad) ad.update(txt());
  }

  // ---- Power: the watcher, and turning the TV on from Home --------------
  // (Re)starts the root power watcher (power.js) for the current mode. It is
  // also checked after every wake, because the TV can kill it on resume.
  function armWatcher(delay) {
    if (watchTimer) clearTimeout(watchTimer);
    const gen = generation;
    watchTimer = setTimeout(() => {
      watchTimer = null;
      if (gen !== generation || !running) return;
      doArmWatcher(gen).catch((e) => {
        watcher = { error: e.message };
        log('power watcher: ' + e.message);
      });
    }, delay === undefined ? 3000 : delay);
  }

  async function doArmWatcher(gen) {
    const low = cfg.offMode === 'lowpower';
    const sig = JSON.stringify([cfg.offMode, low ? cfg.deepSleepMin : 0]);
    if (sig === watchSig) {
      const alive = await ctx.execute(power.ALIVE, 5000);
      if (/alive/.test((alive && alive.stdout) || '')) return;
      if (gen !== generation || !running) return;
      log('power watcher was not running; starting it again');
    }
    const script = power.watcherScript({
      mode: cfg.offMode,
      deepSleepMin: cfg.deepSleepMin,
      api: 'http://127.0.0.1:' + (parseInt(process.env.VETRO_PORT || '', 10) || 8099) + '/plugins/homekit/api',
    });
    // Two commands: a pkill in the same command line as the script's text
    // would match, and kill, its own shell.
    await ctx.execute(power.KILL, 5000).catch(() => {});
    const r = await ctx.execute(power.startCommand(script), 10000);
    const out = (r && r.stdout) || '';
    if (!/armed/.test(out)) throw new Error('could not start the power watcher: ' + ((r && (r.stderr || r.stdout)) || 'no output'));
    if (!/armed scope/.test(out)) log('power watcher: systemd-run did not start it; started it directly');
    if (gen !== generation || !running) return;
    watchSig = sig;
    watcher = { since: Date.now() };
    log('power watcher ready (when off: ' + (low ? 'stay in low power' + (cfg.deepSleepMin ? ', full sleep after ' + cfg.deepSleepMin + ' min' : '') : 'full sleep' + (cfg.offMode === 'relay' ? ', the relay answers' : '')) + ')');
  }

  function stopWatcher() {
    if (watchTimer) clearTimeout(watchTimer);
    watchTimer = null;
    watchSig = '';
    watcher = null;
    ctx.execute(power.KILL, 5000).catch(() => {});
  }

  function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // 'lcdon' (lit), 'lowpower' or 'standby' (dark); null if it cannot be read
  // (the root agent takes a few seconds to come back after a wake). `tries`
  // reads are 1.5 s apart.
  async function powerState(tries) {
    for (let i = 0; i < (tries || 1); i++) {
      if (i) await wait(1500);
      const r = await ctx.execute(power.STATE, 5000).catch(() => null);
      const st = power.parseState(r && r.stdout);
      if (st) return st;
    }
    return null;
  }

  // Home asked for the TV to be on. This code runs only while the system is
  // up: the TV is either lit already, or dark (low power after a power-off, the
  // seconds of standby before that, or a dark wake). The power key is a
  // toggle, so it is pressed only when the TV itself says it is not lit.
  // One more press follows if the first did not light it: after 5 s, or
  // sooner when the first press came during standby and the TV has since
  // settled in low power (a key that lands just as standby turns into low
  // power is swallowed). "Settled" is three reads in a row, so a press that
  // is only slow to act is not answered with a second one that turns the TV
  // off again.
  async function powerOn() {
    if (poweringOn) return;
    poweringOn = true;
    try {
      let st = await powerState(4);
      if (!st) { log('power on: could not read the power state; nothing pressed'); return; }
      if (st === 'lcdon') {
        log('power on requested: already on');
        if (tvModel) tvModel.setActive(true);
        return;
      }
      for (let press = 1; press <= 2; press++) {
        log(press === 1 ? 'power on requested while ' + st + ': pressing the power key' : 'still dark (' + st + '): pressing the power key again');
        const pressedIn = st;
        fastUntil = Date.now() + 30000;
        await tv.key('XF86PowerOff');
        const until = Date.now() + 5000;
        let settled = 0;
        while (Date.now() < until) {
          await wait(500);
          st = (await powerState()) || st;
          if (st === 'lcdon') {
            log('TV is on');
            if (tvModel) tvModel.setActive(true);
            return;
          }
          settled = pressedIn === 'standby' && st === 'lowpower' ? settled + 1 : 0;
          if (settled >= 3) break;
        }
      }
      log('power on: the TV is still ' + st + ' after two presses');
    } catch (e) {
      log('power on failed: ' + e.message);
    } finally {
      poweringOn = false;
    }
  }

  // ---- Relay: a server on the network that answers for the TV while it sleeps --
  // (relay/relay.js; the protocol is in relaylink.js.) When the TV powers off
  // it hands its HomeKit identity and accessory database to the relay, stops
  // advertising and hangs up on controllers, which then find the relay. When
  // the TV is lit again it takes everything back. A dark wake changes nothing.
  function relayKey() {
    if (!relayKeyCache || relayKeyCache.secret !== cfg.relay.secret) relayKeyCache = { secret: cfg.relay.secret, key: link.key(cfg.relay.secret) };
    return relayKeyCache.key;
  }

  // Where the relay is: the address from the settings page, else Bonjour
  // (remembered for 10 minutes, and kept as a last resort if it stops answering).
  async function relayTarget(fresh) {
    if (cfg.relay.address) {
      const fixed = link.parseAddress(cfg.relay.address);
      if (!fixed) throw new Error('the relay address "' + cfg.relay.address + '" is not valid');
      return { ip: fixed.ip, port: fixed.port, name: fixed.ip };
    }
    if (!fresh && relayFound && Date.now() - relayFound.at < 600000) return relayFound;
    const list = await link.find(1500);
    if (list.length) { relayFound = Object.assign({ at: Date.now() }, list[0]); return relayFound; }
    if (relayFound) return relayFound;
    throw new Error('no relay found on the network');
  }

  // One sealed call; a relay that moved is looked up again once.
  async function relayCall(path, obj) {
    try {
      return await link.call(await relayTarget(false), relayKey(), path, obj);
    } catch (e) {
      if (e.code === 'secret' || cfg.relay.address) throw e;
      return link.call(await relayTarget(true), relayKey(), path, obj);
    }
  }

  function relayDo(fn) {
    relayQueue = relayQueue.then(fn, fn);
    return relayQueue;
  }

  function relayFailed(e) {
    relayStatus = { state: e.code === 'secret' ? 'secret' : 'unreachable', error: e.message, at: Date.now() };
  }

  // For the settings page: is the relay there, and does it have our secret?
  function checkRelay() {
    return relayDo(async () => {
      if (!cfg || cfg.offMode !== 'relay') { relayStatus = { state: 'off' }; return; }
      if (!cfg.relay.secret) { relayStatus = { state: 'nosecret' }; return; }
      try {
        const r = await relayCall('/hello', {});
        const t = await relayTarget(false);
        relayStatus = { state: 'ok', name: r.name || t.name, ip: t.ip, port: t.port, at: Date.now() };
      } catch (e) {
        // Logged once per reason: this runs every 30 s until the relay is there.
        if (relayStatus.error !== e.message) log('relay: ' + e.message);
        relayFailed(e);
      }
    });
  }

  // While the relay is not connected, look again every 30 s, so the settings
  // page turns green by itself once the relay is started. Once connected,
  // every 10 minutes.
  function recheckRelay() {
    if (!running || !cfg || cfg.offMode !== 'relay' || !cfg.relay.secret || handedOver) return;
    if (relayStatus.state === 'ok' && Date.now() - (relayStatus.at || 0) < 600000) return;
    checkRelay();
  }

  // This TV's address and the MAC a magic packet must carry.
  function ownNetwork() {
    const all = os.networkInterfaces();
    const names = Object.keys(all).sort((a, b) => (/^(wlan|eth)/.test(b) ? 1 : 0) - (/^(wlan|eth)/.test(a) ? 1 : 0));
    for (const n of names) {
      for (const a of all[n] || []) {
        if ((a.family === 'IPv4' || a.family === 4) && !a.internal && a.mac && a.mac !== '00:00:00:00:00:00') return { ip: a.address, mac: a.mac };
      }
    }
    return null;
  }

  // Called when the TV starts to power off.
  function handToRelay() {
    return relayDo(async () => {
      if (!running || !tvModel || cfg.offMode !== 'relay' || handedOver || !isPaired()) return;
      if (!cfg.relay.secret) { log('relay: no secret set; Home will show No Response while the TV sleeps'); return; }
      try {
        const net = ownNetwork();
        if (!net) throw new Error('no network interface');
        await relayCall('/handover', {
          tv: { name: cfg.name, mac: net.mac, ip: net.ip, port: parseInt(process.env.VETRO_PORT || '', 10) || 8099 },
          identity: { deviceId: cfg.deviceId, ltsk: cfg.ltsk, ltpk: cfg.ltpk, pairings: cfg.pairings },
          txt: txt(),
          accessories: tvModel.accessory.toJSON(),
          power: tvModel.relayInfo.power,
          input: tvModel.relayInfo.input,
        });
        const t = await relayTarget(false);
        handedOver = true;
        handedAt = Date.now();
        relayStatus = { state: 'ok', name: t.name, ip: t.ip, port: t.port, at: Date.now() };
        // Leave the stage: controllers find the relay through Bonjour.
        // A controller that reconnects to this address before the TV is asleep
        // would stay until the sleep cuts it off, so it is turned away.
        if (ad) { try { ad.stop(); } catch (e) { /* closed */ } ad = null; }
        if (hap) hap.setAccepting(false);
        log('handed HomeKit to the relay at ' + t.ip);
      } catch (e) {
        relayFailed(e);
        log('relay handover failed: ' + e.message + '; Home will show No Response while the TV sleeps');
      }
    });
  }

  // What happened while the relay stood in: pairing changes, and writes worth
  // replaying (an input chosen in Home, a rename, a hidden input).
  function applyRelayResult(r) {
    if (r.pairings) {
      cfg.pairings = r.pairings;
      save();
      log('pairings changed while the relay stood in');
      if (ad) ad.update(txt());
      if (!isPaired()) {
        forgetHomeChoices(cfg);
        save();
        log('removed from Home; Home\'s names and hidden inputs forgotten');
        const gen = generation;
        setTimeout(() => { if (gen === generation && running) restartStack(); }, 1500);
        return;
      }
    }
    const replay = (r.writes || []).filter((w) => ['E7', 'E3', '134'].indexOf(w.type) >= 0);
    if (!replay.length) return;
    // Names first; the input last, and only once the TV has finished waking.
    replay.sort((a, b) => (a.type === 'E7' ? 1 : 0) - (b.type === 'E7' ? 1 : 0));
    const gen = generation;
    setTimeout(() => {
      if (gen !== generation || !running || !tvModel) return;
      for (const w of replay) {
        const c = tvModel.accessory.characteristic(1, w.iid);
        if (!c || c.type !== w.type) continue;
        log('replaying a write made while the relay stood in: 1.' + w.iid + '=' + JSON.stringify(w.value).slice(0, 60));
        tvModel.accessory.write(c, w.value, null).catch((e) => log('replay of 1.' + w.iid + ' failed: ' + (e.message || e)));
      }
    }, r.woke ? 6000 : 0);
  }

  // Called when the TV is lit again (or the mode changes).
  function takeBack(why) {
    return relayDo(async () => {
      if (!handedOver) return;
      let r = null;
      try { r = await relayCall('/release', {}); } catch (e) { log('relay release failed: ' + e.message + ' (the relay stands down by itself when it sees the TV)'); }
      handedOver = false;
      if (hap) hap.setAccepting(true);
      if (running && !ad) ad = mdns.advertise({ name: cfg.name, type: '_hap._tcp', port, txt: txt(), log });
      log('took HomeKit back from the relay (' + why + ')');
      if (r) applyRelayResult(r);
    });
  }

  // After a plugin restart the relay may still stand in from before.
  function releaseStaleRelay() {
    return relayDo(async () => {
      if (!cfg || cfg.offMode !== 'relay' || !cfg.relay.secret || handedOver) return;
      try {
        const r = await relayCall('/release', {});
        if (r.standingIn) { log('the relay was still standing in from before; took HomeKit back'); applyRelayResult(r); }
      } catch (e) { /* checkRelay reports it */ }
    });
  }

  function poll() {
    if (!running || !tv) return;
    const gen = generation;
    tv.readState().then((s) => {
      if (gen !== generation) return;
      // A record of every change in what the TV says about its power and screen
      // (to find states where the screen is dark but nothing reports standby).
      const sig = 'pm ' + s.pmState + ', power ' + s.power + ', screen ' + s.screen;
      if (sig !== powerSig) {
        if (powerSig) log('TV state: ' + sig + ' (was ' + powerSig + ')');
        powerSig = sig;
      }
      lastState = s;
      lastStateError = null;
      tvModel.applyState(s);
      // A power-off that was cancelled (the power key during standby) lights
      // the TV with no resume signal. The 5 s keep a state read that began
      // before the power-off from undoing the handover.
      if (handedOver && s.power === 'lcdon' && Date.now() - handedAt > 5000) takeBack('the screen is on');
    }, (e) => {
      lastStateError = e.message;
    }).then(() => {
      if (gen !== generation || !running) return;
      pollTimer = setTimeout(poll, Date.now() < fastUntil ? FAST_POLL_MS : POLL_MS);
    });
  }

  // Applies one port's report to cfg.ports[n]; returns whether anything changed.
  // A device is known by its CEC name: a new name on a port means a new
  // device, so a custom name for the port is dropped. A name that goes missing
  // while the device stays plugged in is kept (the TV loses it now and then).
  function applyPort(n, r) {
    const key = 'hdmi' + n;
    const p = cfg.ports[n] || (cfg.ports[n] = { device: '', named: false, connected: null });
    const before = JSON.stringify(p) + JSON.stringify(cfg.custom[key] || null);
    if (!r.connected) {
      if (p.connected !== false) log('HDMI ' + n + ': unplugged');
      p.connected = false;
      p.named = false;
    } else {
      if (p.connected !== true) log('HDMI ' + n + ': ' + (r.name || 'a device without a name') + ' plugged in');
      p.connected = true;
      if (r.name) {
        if (r.name !== p.device) {
          if (p.device) log('HDMI ' + n + ': now ' + r.name + ' (was ' + p.device + ')');
          const c = cfg.custom[key];
          if (c) {
            log('HDMI ' + n + ': new device, dropping the name "' + c.name + '"');
            delete cfg.custom[key];
          }
          p.device = r.name;
        }
        p.named = true;
      }
    }
    return before !== JSON.stringify(p) + JSON.stringify(cfg.custom[key] || null);
  }

  // `immediate` applies every change at once (start-up, the refresh button);
  // otherwise a change must be read twice in a row, so a device switching on
  // or off does not flip names back and forth.
  function applyHdmi(report, immediate) {
    let changed = false;
    for (let n = 1; n <= 4; n++) {
      const r = report[n];
      if (!r || r.connected === null) continue;
      const sig = (r.connected ? '1' : '0') + '|' + (r.name || '');
      if (appliedSig[n] === sig) { delete pendingSig[n]; continue; }
      if (!immediate && appliedSig[n] !== undefined && pendingSig[n] !== sig) { pendingSig[n] = sig; continue; }
      delete pendingSig[n];
      appliedSig[n] = sig;
      if (applyPort(n, r)) changed = true;
    }
    if (changed) {
      save();
      pushNames(false);
    }
  }

  // Reads the ports now and every HDMI_POLL_MS. A call while a read is in
  // flight joins it, so there is only ever one polling chain.
  function refreshHdmi(immediate) {
    if (!running || !tv) return Promise.resolve();
    if (hdmiPending) {
      return immediate ? hdmiPending.then(() => { if (lastHdmi) applyHdmi(lastHdmi, true); }) : hdmiPending;
    }
    const gen = generation;
    if (hdmiTimer) { clearTimeout(hdmiTimer); hdmiTimer = null; }
    const p = Promise.resolve().then(() => tv.hdmi()).then((ports) => {
      if (gen !== generation) return;
      lastHdmi = ports;
      lastHdmiAt = Date.now();
      lastHdmiError = null;
      applyHdmi(ports, immediate);
    }, (e) => {
      if (gen !== generation) return;
      if (lastHdmiError !== e.message) log('reading the HDMI ports failed: ' + e.message);
      lastHdmiError = e.message;
    }).then(() => {
      if (hdmiPending === p) hdmiPending = null;
      if (gen === generation && running) hdmiTimer = setTimeout(() => refreshHdmi(false), HDMI_POLL_MS);
    });
    hdmiPending = p;
    return p;
  }

  // Timers stop while the TV is suspended; a big gap between ticks means we just woke up.
  function checkWake() {
    const now = Date.now();
    const gap = now - lastTick;
    lastTick = now;
    if (gap > 20000 && running) {
      log('woke up after ' + Math.round(gap / 1000) + ' s');
      // Whether the TV is lit or woke dark comes from the power watcher (the
      // `power/` route) and from the state poll, which runs fast for a while.
      if (ad) ad.restart();
      fastUntil = now + 30000;
      refreshHdmi(false);
      // The TV may kill the power watcher as it resumes. Check it once the
      // root agent is back (it reconnects a few seconds after a resume), and
      // again a little later.
      armWatcher(8000);
      const gen = generation;
      setTimeout(() => { if (gen === generation && running) armWatcher(0); }, 30000);
    }
  }

  async function startStack() {
    loadConfig();
    appliedSig = {};
    pendingSig = {};
    const missing = hc.missingFeatures();
    if (missing.length) throw new Error('This TV\'s Node (' + process.version + ') lacks: ' + missing.join(', '));
    tv = new Tv(ctx.execute);
    tvModel = television.buildTelevision({
      name: cfg.name,
      model: 'Samsung TV (Vetro)',
      serial: cfg.deviceId.replace(/:/g, ''),
      firmware: VERSION,
      inputs: syncedInputs(),
      tv,
      log,
      // key is null for the TV's own name.
      onRename(key, name) {
        if (key === null) {
          if (Date.now() - pairedAt < PAIR_RENAME_MS && isNameSuffix(cfg.name, name)) {
            log('kept the name "' + cfg.name + '" (Home suggested "' + name + '")');
            return false;
          }
          cfg.name = name;
          save();
          return undefined;
        }
        if (PLACEHOLDER_RE.test(name)) {
          log('ignored the Home placeholder "' + name + '" for ' + key);
          return false;
        }
        const input = allInputs().find((i) => i.key === key);
        if (input && input.autoName === name) delete cfg.custom[key];
        else cfg.custom[key] = { name, from: 'home' };
        log(key + ' renamed in Home to "' + name + '"');
        save();
        return undefined;
      },
      onVisibility(key, hidden) {
        if (hidden) cfg.hidden[key] = true;
        else delete cfg.hidden[key];
        save();
      },
      onPowerOff() { tvModel.setActive(false); },
      onPowerOn() { powerOn(); },
    });
    bumpConfigNumber(tvModel.accessory);

    hap = new HapServer({
      accessory: tvModel.accessory,
      store: store(),
      setupCode: cfg.setupCode,
      log,
      onIdentify: () => { log('identify'); tv.key('XF86Info').catch(() => {}); },
    });
    hap.server.on('error', (e) => log('HAP server error: ' + e.message));
    hap.on('paired', (paired) => {
      if (ad) ad.update(txt());
      if (paired) { pairedAt = Date.now(); return; }
      // Removed from Home: forget Home's names and hidden inputs, and rebuild
      // so the next add starts clean.
      forgetHomeChoices(cfg);
      save();
      log('removed from Home; Home\'s names and hidden inputs forgotten');
      const gen = generation;
      setTimeout(() => { if (gen === generation && running) restartStack(); }, 1500);
    });
    const origWrite = tvModel.accessory.write.bind(tvModel.accessory);
    tvModel.accessory.write = function (c, v, conn) {
      fastUntil = Date.now() + 15000;
      return origWrite(c, v, conn);
    };
    try {
      port = await hap.listen(cfg.port);
    } catch (e) {
      log('port ' + cfg.port + ' busy, picking another');
      cfg.port = 0;
      port = await hap.listen(0);
      cfg.port = port;
      save();
    }
    log('HAP listening on port ' + port + ' with ' + syncedInputs().length + ' inputs');

    ad = mdns.advertise({ name: cfg.name, type: '_hap._tcp', port, txt: txt(), log });
    running = true;
    lastTick = Date.now();
    wakeTimer = setInterval(checkWake, 5000);
    armWatcher(4000);
    handedOver = false;
    releaseStaleRelay();
    checkRelay();
    relayTimer = setInterval(recheckRelay, 30000);
    poll();
    refreshHdmi(true);
  }

  function stopStack() {
    running = false;
    generation++;
    if (pollTimer) clearTimeout(pollTimer);
    if (wakeTimer) clearInterval(wakeTimer);
    if (relayTimer) clearInterval(relayTimer);
    relayTimer = null;
    if (hdmiTimer) clearTimeout(hdmiTimer);
    pollTimer = null;
    wakeTimer = null;
    hdmiTimer = null;
    hdmiPending = null;
    stopWatcher();
    if (ad) { try { ad.stop(); } catch (e) { /* closed */ } }
    if (hap) { try { hap.close(); } catch (e) { /* closed */ } }
    ad = null;
    hap = null;
  }

  function restartStack() {
    stopStack();
    startError = null;
    return startStack().catch((e) => {
      startError = e.message;
      log('start failed: ' + (e.stack || e));
    });
  }

  // Replaces the app list, keeping each app's HomeKit identifier (11-30) stable.
  function setApps(list) {
    const old = new Map(cfg.apps.map((a) => [a.appId, a]));
    const seen = new Set();
    const keep = list.filter((a) => {
      if (!a || !APP_ID_RE.test(a.appId) || seen.has(a.appId)) return false;
      seen.add(a.appId);
      return true;
    }).slice(0, 20);
    const used = new Set(keep.filter((a) => old.has(a.appId)).map((a) => old.get(a.appId).id));
    cfg.apps = keep.map((a) => {
      const prev = old.get(a.appId);
      if (prev) return { id: prev.id, appId: a.appId, name: prev.name };
      let id = 11;
      while (used.has(id)) id++;
      used.add(id);
      return { id, appId: a.appId, name: String(a.name || a.appId).slice(0, 40) };
    });
    const keys = new Set(allInputs().map((i) => i.key));
    for (const m of [cfg.custom, cfg.sync, cfg.hidden]) {
      for (const k of Object.keys(m)) if (!keys.has(k)) delete m[k];
    }
  }

  // POST config: { name?, offMode?, deepSleepMin?, relayAddress?, relaySecret?, inputs?: [{ key, synced, name, appName? }] }.
  // `inputs` is the full list; apps not in it are removed.
  function applyConfig(body) {
    if (typeof body.name === 'string' && body.name.trim()) cfg.name = homeKitName(body.name, cfg.name);
    if (OFF_MODES.indexOf(body.offMode) >= 0) cfg.offMode = body.offMode;
    if (DEEP_SLEEP_MIN.indexOf(body.deepSleepMin) >= 0) cfg.deepSleepMin = body.deepSleepMin;
    if (typeof body.relayAddress === 'string') cfg.relay.address = body.relayAddress.trim().slice(0, 100);
    // The relay refuses secrets shorter than 8 characters. An empty one forgets the saved secret.
    if (typeof body.relaySecret === 'string' && (body.relaySecret.length >= 8 || body.relaySecret === '')) cfg.relay.secret = body.relaySecret.slice(0, 200);
    if (!Array.isArray(body.inputs)) return;
    const rows = body.inputs.filter((x) => x && typeof x.key === 'string');
    setApps(rows.filter((x) => x.key.indexOf('app:') === 0).map((x) => ({ appId: x.key.slice(4), name: x.appName })));
    const byKey = new Map(allInputs().map((i) => [i.key, i]));
    for (const x of rows) {
      const input = byKey.get(x.key);
      if (!input) continue;
      if (typeof x.synced === 'boolean' && input.kind !== 'home') cfg.sync[x.key] = x.synced;
      if (x.name === undefined) continue;
      const v = x.name === null ? '' : homeKitName(x.name, '');
      if (!v || v === input.autoName) delete cfg.custom[x.key];
      else if (!cfg.custom[x.key] || cfg.custom[x.key].name !== v) cfg.custom[x.key] = { name: v, from: 'page' };
    }
  }

  function state() {
    const paired = isPaired();
    return {
      version: VERSION,
      node: process.version,
      running,
      error: startError,
      port,
      name: cfg && cfg.name,
      paired,
      setupCode: cfg && !paired ? cfg.setupCode : null,
      controllers: cfg ? Object.keys(cfg.pairings).map((id) => ({ id, admin: cfg.pairings[id].admin })) : [],
      connections: hap ? hap.controllerCount() : 0,
      recentRequests: hap ? hap.recent.slice(-60) : [],
      pollMs: HDMI_POLL_MS,
      hdmiCheckedAgo: lastHdmiAt ? Math.round((Date.now() - lastHdmiAt) / 1000) : null,
      hdmiError: lastHdmiError,
      inputs: cfg ? allInputs().map((i) => ({
        key: i.key,
        id: i.id,
        kind: i.kind,
        port: i.hdmi || null,
        appId: i.appId || null,
        synced: i.synced,
        name: i.configuredName,
        autoName: i.autoName,
        customName: i.customName,
        customFrom: i.customFrom,
        connected: i.kind === 'hdmi' ? (cfg.ports[i.hdmi] ? cfg.ports[i.hdmi].connected : null) : null,
        detected: i.kind === 'hdmi' && lastHdmi && lastHdmi[i.hdmi] ? lastHdmi[i.hdmi].name : null,
        hiddenInHome: i.hidden,
      })) : [],
      tv: lastState,
      tvError: lastStateError,
      mdns: ad ? ad.status() : null,
      offMode: cfg ? cfg.offMode : 'remote',
      deepSleepMin: cfg ? cfg.deepSleepMin : 0,
      watcher,
      // Never the secret itself.
      relay: cfg ? { address: cfg.relay.address, secretSet: !!cfg.relay.secret, status: relayStatus, handedOver } : null,
      log: logLines,
    };
  }

  function loadPage() {
    try { page = fs.readFileSync(path.join(ctx.dir || __dirname, 'ui.html'), 'utf8'); } catch (e) { page = '<p>ui.html missing</p>'; }
    return page;
  }

  function sendJson(res, code, obj) {
    res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(obj));
  }

  function route(req, res, sub) {
    if (sub === 'ui' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(page || loadPage());
      return true;
    }
    if (sub === 'state' && req.method === 'GET') {
      sendJson(res, 200, state());
      return true;
    }
    // For the relay: has the TV taken HomeKit back? (No secrets.)
    if (sub === 'relay' && req.method === 'GET') {
      sendJson(res, 200, { handedOver });
      return true;
    }
    if (sub === 'apps' && req.method === 'GET') {
      if (!tv) { sendJson(res, 409, { error: 'not running' }); return true; }
      tv.apps().then((list) => sendJson(res, 200, { apps: list }), (e) => sendJson(res, 502, { error: e.message }));
      return true;
    }
    if (sub === 'config' && req.method === 'POST') {
      readJson(req, (body) => {
        if (!body || !cfg) { sendJson(res, 400, { error: 'bad JSON' }); return; }
        const layout = layoutKey();
        const oldName = cfg.name;
        const oldPower = cfg.offMode + '/' + cfg.deepSleepMin;
        const oldRelay = cfg.relay.address + '|' + cfg.relay.secret;
        applyConfig(body);
        save();
        const powerChanged = cfg.offMode + '/' + cfg.deepSleepMin !== oldPower;
        const relayChanged = powerChanged || cfg.relay.address + '|' + cfg.relay.secret !== oldRelay;
        const afterRelay = () => {
          if (cfg.offMode !== 'relay') takeBack('the mode changed');
          return relayChanged ? checkRelay() : Promise.resolve();
        };
        if (layoutKey() !== layout || !running) {
          log('settings saved; rebuilding HomeKit');
          restartStack().then(() => relayQueue).then(() => sendJson(res, 200, state()));
        } else {
          const renamed = !!tvModel && cfg.name !== oldName;
          if (renamed) tvModel.setName(cfg.name);
          pushNames(true, renamed);
          if (powerChanged) armWatcher(0);
          log('settings saved');
          // The answer waits for the relay check, so the page shows its result.
          afterRelay().then(() => sendJson(res, 200, state()));
        }
      });
      return true;
    }
    if (sub === 'refresh' && req.method === 'POST') {
      readJson(req, () => {
        if (!running) { sendJson(res, 409, { error: 'not running' }); return; }
        refreshHdmi(true).then(() => sendJson(res, 200, state()));
      });
      return true;
    }
    // From the power watcher: the TV is entering standby (any power-off,
    // including the remote). Tell Home it is off while this process still runs.
    if (sub === 'standby' && req.method === 'POST') {
      if (tvModel) tvModel.setActive(false);
      log('TV entering standby');
      handToRelay();
      sendJson(res, 200, { ok: true });
      return true;
    }
    // From the power watcher after a resume: power/<state>/<wake reason>.
    // lcdon is a lit wake; anything else is a dark one and Home keeps showing off.
    const resumed = /^power\/([a-z]+)\/(\d+)$/.exec(sub);
    if (resumed && req.method === 'POST') {
      const lit = resumed[1] === 'lcdon';
      if (tvModel) tvModel.setActive(lit);
      log('TV resumed ' + (lit ? 'lit' : 'dark (' + resumed[1] + ')') + ', wake reason ' + resumed[2]);
      if (lit) takeBack('the TV is on');
      fastUntil = Date.now() + 15000;
      sendJson(res, 200, { ok: true });
      return true;
    }
    if (sub === 'sync' && req.method === 'POST') {
      readJson(req, () => {
        if (!cfg) { sendJson(res, 409, { error: 'not running' }); return; }
        nextConfigNumber();
        save();
        log('rewriting everything to HomeKit');
        restartStack().then(() => sendJson(res, 200, state()));
      });
      return true;
    }
    // Replies first, then restarts the HAP stack (Bonjour and the power watcher included).
    if (sub === 'restart' && req.method === 'POST') {
      readJson(req, () => {
        log('restart requested from the settings page');
        sendJson(res, 200, { ok: true });
        const gen = generation;
        setTimeout(() => { if (gen === generation && running) restartStack(); }, 300);
      });
      return true;
    }
    // Starts over: no pairings, a new accessory identity (so iPhones treat the
    // TV as a brand-new accessory, not a cached one), a new setup code, and
    // default names and inputs.
    if (sub === 'reset' && req.method === 'POST') {
      readJson(req, () => {
        stopStack();
        try { ctx.config.set({}); } catch (e) { log('clearing config failed: ' + e.message); }
        log('HomeKit reset: pairings, identity, names and inputs cleared');
        restartStack().then(() => sendJson(res, 200, state()));
      });
      return true;
    }
    return false;
  }

  return {
    start() {
      startError = null;
      startStack().catch((e) => {
        startError = e.message;
        running = false;
        log('start failed: ' + (e.stack || e));
      });
    },
    stop() { stopStack(); },
    status() {
      return { running, port, paired: isPaired(), connections: hap ? hap.controllerCount() : 0, error: startError || undefined };
    },
    route,
  };
};
