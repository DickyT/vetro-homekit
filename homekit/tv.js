'use strict';
// TV control through Vetro: keys go through Vetro's own /control endpoint on
// loopback (it routes XF86Home to Vetro's launcher), everything else is a root
// command through ctx.execute.

const http = require('http');

const DISPLAY = '--system --dest org.tizen.system.deviced --object-path /Org/Tizen/System/DeviceD/Display'
  + ' --method org.tizen.system.deviced.display';
const TV_STATE_DLL = '/opt/usr/apps/vetrotvapp/res/wgt/native/TvState.dll';
const STATE_CMD = '/usr/bin/dotnet ' + TV_STATE_DLL + ' 2>/dev/null; echo; '
  + 'vconftool get memory/appfw/current_fullscreen_appid 2>/dev/null; '
  + 'vconftool get memory/pm/state 2>/dev/null; '
  // deviced's own view: ('lcdon',) and (1,) while the screen is lit.
  + 'gdbus call ' + DISPLAY + '.GetPowerState 2>/dev/null; gdbus call ' + DISPLAY + '.GetScreenState 2>/dev/null';
const APP_ID_RE = /^[A-Za-z0-9_.-]{1,128}$/;
const SOURCE_CACHES = [
  '/opt/usr/home/owner/apps_rw/com.samsung.tv.home.sidebar/data/.sourceCache',
  '/opt/usr/home/owner/apps_rw/com.samsung.tv.csfs/data/.sourceCache',
];
// Vetro's launcher settings: `enabled` is Vetro's own launcher, `customApp` the
// app set as the launcher instead. With neither, Samsung's Home answers the key.
const DOCK_STATE = '/opt/usr/home/owner/share/vetro-dock.json';
const KEYS = [
  'XF86AudioRaiseVolume', 'XF86AudioLowerVolume', 'XF86AudioMute', 'XF86PowerOff',
  'Up', 'Down', 'Left', 'Right', 'Return', 'XF86Back', 'XF86Home', 'XF86Menu', 'XF86Info', 'XF86Exit',
  'XF86DiscretSourceTV', 'XF86DiscretHDMI1', 'XF86DiscretHDMI2', 'XF86DiscretHDMI3', 'XF86DiscretHDMI4',
  'XF86PlayBack', 'XF86AudioNext', 'XF86AudioPrev', 'XF86AudioRewind', 'XF86AudioForward',
];

// What the Home key opens, from the text of Vetro's launcher state:
// { kind: 'vetro' } | { kind: 'app', appId } | { kind: 'samsung' }.
function homeTarget(text) {
  let d = null;
  try { d = JSON.parse(text); } catch (e) { /* unreadable: Samsung's */ }
  if (d && d.enabled === true) return { kind: 'vetro' };
  if (d && typeof d.customApp === 'string' && APP_ID_RE.test(d.customApp)) return { kind: 'app', appId: d.customApp };
  return { kind: 'samsung' };
}

function vetroPort() {
  const p = parseInt(process.env.VETRO_PORT || '', 10);
  return p > 0 ? p : 8099;
}

// Calls Vetro's HTTP API on loopback. No Origin header, so Vetro treats it as
// the TV itself and needs no sign-in.
function local(method, path, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request({
      host: '127.0.0.1', port: vetroPort(), method, path,
      headers: data ? { 'content-type': 'application/json', 'content-length': data.length } : {},
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch (e) { /* not JSON */ }
        if (res.statusCode >= 400) reject(new Error(method + ' ' + path + ' -> ' + res.statusCode + ' ' + text.slice(0, 200)));
        else resolve(json);
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs || 10000, () => req.destroy(new Error('timeout')));
    if (data) req.write(data);
    req.end();
  });
}

function vconfValue(text, key) {
  const re = new RegExp(key.replace(/\//g, '\\/') + ', value = (.*) \\((\\w+)\\)');
  const m = re.exec(text);
  return m ? m[1] : null;
}

function parseState(stdout) {
  const text = String(stdout || '');
  const out = { volume: null, muted: null, source: null, sourceType: null, foreground: null, pmState: null, power: null, screen: null };
  const brace = text.indexOf('{');
  const end = text.indexOf('}', brace);
  if (brace >= 0 && end > brace) {
    try {
      const d = JSON.parse(text.slice(brace, end + 1));
      if (Number.isInteger(d.volume) && d.volume >= 0 && d.volume <= 100) out.volume = d.volume;
      if (typeof d.muted === 'boolean') out.muted = d.muted;
      if (Number.isInteger(d.sourceType)) {
        out.sourceType = d.sourceType;
        if (d.sourceType === 0) out.source = 'TV';
        else if (d.sourceType >= 13 && d.sourceType <= 16) out.source = 'HDMI' + (d.sourceType - 12);
      }
    } catch (e) { /* leave nulls */ }
  }
  out.foreground = vconfValue(text, 'memory/appfw/current_fullscreen_appid');
  const pm = vconfValue(text, 'memory/pm/state');
  out.pmState = pm === null ? null : parseInt(pm, 10);
  const power = /^\('([a-z]+)',\)\s*$/m.exec(text);
  const screen = /^\((\d+),\)\s*$/m.exec(text);
  out.power = power ? power[1] : null;
  out.screen = screen ? parseInt(screen[1], 10) : null;
  return out;
}

class Tv {
  constructor(execute) {
    this.execute = execute;
    this.pending = null;
  }

  key(name) {
    if (KEYS.indexOf(name) < 0) return Promise.reject(new Error('unknown key ' + name));
    return local('POST', '/control', { key: name }, 10000).then((r) => {
      if (r && r.ok === false) throw new Error('key ' + name + ' failed: ' + (r.stderr || r.output || ''));
      return r;
    });
  }

  // Open what the Home key opens. A software Home key reaches Samsung's Home
  // first, which then flashes before a custom launcher covers it, so a custom
  // launcher is started directly. Vetro's own launcher is reached by the key.
  home() {
    return this.execute('cat ' + DOCK_STATE + ' 2>/dev/null', 5000).then((r) => homeTarget(r.stdout || ''), () => ({ kind: 'samsung' }))
      .then((t) => {
        if (t.kind !== 'app') return this.key('XF86Home');
        return this.launch(t.appId).catch(() => this.key('XF86Home'));
      });
  }

  launch(appId) {
    if (!APP_ID_RE.test(appId)) return Promise.reject(new Error('bad app id'));
    return this.execute('/usr/bin/app_launcher -s ' + appId + ' 2>&1', 15000).then((r) => {
      if (r.timed_out || r.exit_code) throw new Error('launch ' + appId + ' failed: ' + (r.stdout || r.stderr || r.exit_code));
      return r;
    });
  }

  // { volume, muted, source ('TV'|'HDMI1'..), sourceType, foreground (app id), pmState,
  //   power ('lcdon'|'standby'|'lowpower'|..), screen (1 lit, 0 dark) }
  readState() {
    if (this.pending) return this.pending;
    this.pending = this.execute(STATE_CMD, 10000).then((r) => {
      this.pending = null;
      if (r.timed_out) throw new Error('state read timed out');
      return parseState(r.stdout);
    }, (e) => {
      this.pending = null;
      throw e;
    });
    return this.pending;
  }

  // What is on each HDMI port:
  //   { 1: { connected: true|false|null, name: 'PlayStation 5'|null, audio: bool }, ... 4: ... }
  // `connected` comes from the HDMI switch's hot-plug state (H<n>_c=0 means a
  // device is plugged in; ports that do not exist read 1). `name` is the
  // HDMI-CEC name from Samsung's own source list, which can be stale, so it is
  // used only for ports that are plugged in. `audio` marks a sound device
  // (a soundbar on the eARC port).
  hdmi() {
    const files = SOURCE_CACHES.map((f) => '"' + f + '"').join(' ');
    const cmd = 'cat /sys/class/extcon/extcon0/state 2>/dev/null; echo "@@SOURCES@@"; '
      + 'for f in ' + files + '; do if [ -f "$f" ]; then cat "$f"; break; fi; done';
    return this.execute(cmd, 10000).then((r) => {
      if (r.timed_out) throw new Error('HDMI state read timed out');
      const parts = String(r.stdout || '').split('@@SOURCES@@');
      let cache = {};
      try { cache = JSON.parse(parts[1] || '{}'); } catch (e) { cache = {}; }
      const out = {};
      for (let n = 1; n <= 4; n++) {
        const m = new RegExp('H' + n + '_c=([01])').exec(parts[0] || '');
        const connected = m ? m[1] === '0' : null;
        // Samsung keys a port "HDMI2" until it identifies the device over CEC,
        // then "HDMI2/0" (and "/1"... for more devices behind the port).
        const key = 'HDMI' + n;
        const entries = Object.keys(cache).sort()
          .filter((k) => k === key || k.indexOf(key + '/') === 0)
          .map((k) => cache[k])
          .filter((e) => e && typeof e === 'object');
        const entry = entries.find((e) => e.EditName || e.DetectedName) || entries[0];
        let name = entry && (entry.EditName || entry.DetectedName);
        name = connected !== false && typeof name === 'string' && name.trim() ? name.trim().slice(0, 40) : null;
        out[n] = { connected, name, audio: !!(entry && entry.SourceCategory === 5) };
      }
      return out;
    });
  }

  // Installed apps from Vetro's inventory: [{ appId, name }]
  apps() {
    return local('GET', '/apps', undefined, 20000).then((r) => {
      const list = (r && r.apps) || [];
      return list
        .filter((a) => a && a.appId && APP_ID_RE.test(a.appId) && a.show !== false)
        .map((a) => ({ appId: a.appId, name: a.name || a.appId }));
    });
  }
}

module.exports = { Tv, KEYS, parseState, homeTarget };
