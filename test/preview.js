'use strict';
// Local preview of the settings page: runs the shard on this machine with a
// fake Vetro (root commands return a canned TV state, and a stub HTTP server
// stands in for Vetro's /control endpoint) and serves the shard's own routes
// on the stub port under /plugins/homekit/api/<sub>.
//   HK_STUB_PORT=8123 node test/preview.js /tmp/hk-preview 3600
//   then open http://localhost:8123/plugins/homekit/api/ui
// The config directory is a throwaway: the setup code on the page belongs to
// this fake instance. Bonjour stays off unless HK_LOCAL_MDNS=1.
//   HK_HDMI_MOCK=<file>: HDMI switch state, re-read on every poll (default below).

const http = require('http');
const fs = require('fs');
const path = require('path');

const dir = process.argv[2];
const seconds = parseInt(process.argv[3] || '120', 10);
fs.mkdirSync(dir, { recursive: true });
const cfgFile = path.join(dir, 'config.json');

const tvState = { volume: 21, muted: false, sourceType: 13, foreground: 'org.tizen.tv-viewer' };

// H<n>_c=0 means a device is plugged in; the JSON after @@SOURCES@@ is the CEC source list.
const HDMI_DEFAULT = 'H1_c=1\nH2_c=0\nH3_c=0\nH4_c=0\n@@SOURCES@@\n'
  + '{"TV":{},"HDMI2/0":{"EditName":"Apple TV","DetectedName":"Apple TV","SourceCategory":0},'
  + '"HDMI3":{"EditName":"Sonos Arc","DetectedName":"Sonos Arc","SourceCategory":5},'
  + '"HDMI4":{"EditName":"PlayStation 5","DetectedName":"PlayStation 5","SourceCategory":2}}\n';

let shard = null;
const stub = http.createServer((req, res) => {
  if (req.url.startsWith('/plugins/homekit/api/') && shard) {
    const sub = req.url.slice('/plugins/homekit/api/'.length).split('?')[0];
    if (shard.route(req, res, sub)) { console.log('[shard route]', req.method, sub); return; }
  }
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    console.log('[vetro stub]', req.method, req.url, body);
    if (req.url === '/control') {
      const key = JSON.parse(body).key;
      if (key === 'XF86AudioMute') tvState.muted = !tvState.muted;
      const m = /^XF86DiscretHDMI(\d)$/.exec(key);
      if (m) { tvState.sourceType = 12 + Number(m[1]); tvState.foreground = 'org.tizen.tv-viewer'; }
      res.end(JSON.stringify({ ok: true, key, exit_code: 0 }));
    } else if (req.url === '/apps') {
      res.end(JSON.stringify({ apps: [{ appId: 'com.samsung.tv.cobalt-yt', name: 'YouTube' }, { appId: 'org.tizen.netflix-app', name: 'Netflix' }] }));
    } else {
      res.statusCode = 404;
      res.end('{}');
    }
  });
});

stub.listen(parseInt(process.env.HK_STUB_PORT || '0', 10), '127.0.0.1', () => {
  process.env.VETRO_PORT = String(stub.address().port);
  const ctx = {
    id: 'homekit',
    dir: path.join(__dirname, '..', 'homekit'),
    config: {
      get() { try { return JSON.parse(fs.readFileSync(cfgFile, 'utf8')); } catch (e) { return {}; } },
      set(v) { fs.writeFileSync(cfgFile, JSON.stringify(v, null, 1)); },
    },
    execute(cmd) {
      console.log('[root]', cmd.slice(0, 90));
      if (cmd.includes('setsid nohup')) { global.__armed = (global.__armed || 0) + 1; return Promise.resolve({ exit_code: 0, stdout: 'armed', stderr: '' }); }
      if (cmd.includes('GetPowerState')) return Promise.resolve({ exit_code: 0, timed_out: false, stdout: "('lcdon',)\n", stderr: '' });
      let stdout = '';
      const launch = /app_launcher -s (\S+)/.exec(cmd);
      if (cmd.includes('/sys/class/extcon/extcon0/state')) {
        const f = process.env.HK_HDMI_MOCK;
        stdout = f && fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : HDMI_DEFAULT;
      } else if (launch) tvState.foreground = launch[1];
      else {
        stdout = JSON.stringify({ volume: tvState.volume, muted: tvState.muted, sourceType: tvState.sourceType }) + '\n'
          + 'memory/appfw/current_fullscreen_appid, value = ' + tvState.foreground + ' (String)\n'
          + 'memory/pm/state, value = 1 (Int32)\n';
      }
      return Promise.resolve({ exit_code: 0, timed_out: false, stdout, stderr: '' });
    },
  };
  // The test server must not appear in Home on the local network: it would
  // show up as a second "Samsung TV" and push the real TV's Bonjour name to
  // "Samsung TV (2)". Bonjour stays off unless HK_LOCAL_MDNS=1.
  if (process.env.HK_LOCAL_MDNS !== '1') {
    const p = require.resolve(path.join(__dirname, '..', 'homekit', 'hap', 'mdns'));
    const off = { mode: 'off', detail: 'local test server: not advertised' };
    require.cache[p] = { id: p, filename: p, loaded: true, exports: {
      advertise: () => ({ update() {}, restart() {}, stop() {}, status: () => off }),
    } };
  }
  shard = require(path.join(__dirname, '..', 'homekit'))(ctx);
  shard.start();
  setTimeout(() => {
    const c = ctx.config.get();
    console.log('[harness] port', c.port, 'code', c.setupCode, 'vetro stub', process.env.VETRO_PORT, 'status', JSON.stringify(shard.status()));
  }, 1500);
  setTimeout(() => { shard.stop(); stub.close(); console.log('[harness] stopped'); process.exit(0); }, seconds * 1000);
});
