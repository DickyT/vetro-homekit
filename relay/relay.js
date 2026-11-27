'use strict';
// vetro-homekit relay: stands in for the TV in HomeKit while the TV is in
// full sleep, and wakes it with a magic packet when Home turns it on.
//
// The TV plugin ("Relay" mode) hands its HomeKit identity to this process
// when the TV powers off: its keys and pairings, and its accessory database
// (services, characteristics, instance ids, names) exactly as the TV serves
// it. This process then:
//   - publishes the accessory in Bonjour under "<TV name> Relay" (HomeKit
//     knows an accessory by the id in the TXT record, so controllers move
//     over by themselves, and the TV never finds its own name taken);
//   - answers controllers from that database, with power reported as off;
//   - on a write of power = on, sends magic packets to the TV's MAC;
//   - gives everything back when the TV says it is lit again (/release),
//     along with what happened meanwhile: writes to replay and pairing changes.
// Nothing is kept on disk: a restart of this process forgets the TV until its
// next power-off.
//
// Environment:
//   RELAY_SECRET     required; the same secret is typed into the TV's settings page
//   RELAY_PORT       control port the TV talks to, TCP and UDP (default 8125; the TV
//                    finds the relay by itself only on this default)
//   RELAY_HAP_PORT   HomeKit port while standing in (default 8126)
//   RELAY_NAME       name shown on the TV's settings page (default: host name)
//   RELAY_ADDRESS    this machine's LAN address, if the automatic choice is wrong
//
// Needs the host's network (docker run --network host): Bonjour is multicast,
// and the magic packet and the TV's search for the relay are broadcasts.

const http = require('http');
const os = require('os');
const fs = require('fs');
const path = require('path');
const dgram = require('dgram');
const crypto = require('crypto');

// The plugin's code: next to this file in the image, one level up in the repository.
const CODE = fs.existsSync(path.join(__dirname, 'homekit')) ? path.join(__dirname, 'homekit') : path.join(__dirname, '..', 'homekit');
const link = require(path.join(CODE, 'relaylink'));
const mdns = require(path.join(CODE, 'hap', 'mdns'));
const { HapServer } = require(path.join(CODE, 'hap', 'server'));
const { Accessory } = require(path.join(CODE, 'hap', 'accessory'));

const SECRET = process.env.RELAY_SECRET || '';
const PORT = parseInt(process.env.RELAY_PORT || '', 10) || link.DEFAULT_PORT;
const HAP_PORT = parseInt(process.env.RELAY_HAP_PORT || '', 10) || 8126;
const NAME = (process.env.RELAY_NAME || os.hostname().replace(/\.local$/, '') || 'relay').replace(/[^\w .'-]/g, ' ').slice(0, 40);
const WAKE_AT_MS = [0, 700, 2000, 5000, 10000];
const WAKE_GIVE_UP_MS = 60000;
const CHECK_TV_MS = 5000;

function log(m) { console.log(new Date().toISOString().slice(0, 19).replace('T', ' ') + ' ' + m); }
// There is no system mDNS daemon to register with here; that line is not news.
function bonjourLog(m) { if (!/^mdnsd unavailable/.test(m)) log('bonjour: ' + m); }

if (SECRET.length < 8) {
  console.error('RELAY_SECRET is missing or shorter than 8 characters. Set it, and type the same secret into the TV\'s HomeKit settings page.');
  process.exit(2);
}
const KEY = link.key(SECRET);

// ---- network ---------------------------------------------------------------

const ipInt = (ip) => ip.split('.').reduce((a, b) => ((a * 256) + Number(b)) >>> 0, 0);
const intIp = (n) => [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');

// IPv4 addresses of real LAN interfaces: not loopback, not Docker's bridges, not tunnels.
function lanAddresses() {
  const out = [];
  const all = os.networkInterfaces();
  for (const name of Object.keys(all)) {
    if (/^(lo|docker|br-|veth|virbr|tun|tap|utun|awdl|llw|bridge)/.test(name)) continue;
    for (const a of all[name] || []) {
      if ((a.family === 'IPv4' || a.family === 4) && !a.internal && !/^169\.254\./.test(a.address)) out.push({ name, ip: a.address, netmask: a.netmask });
    }
  }
  return out;
}

// The address to publish and send from: RELAY_ADDRESS, else the interface on
// the same subnet as `peerIp` (the TV), else the first LAN interface.
function ownAddress(peerIp) {
  const list = lanAddresses();
  if (process.env.RELAY_ADDRESS) return list.find((a) => a.ip === process.env.RELAY_ADDRESS) || { ip: process.env.RELAY_ADDRESS, netmask: '255.255.255.0' };
  if (peerIp && /^\d+\.\d+\.\d+\.\d+$/.test(peerIp)) {
    const hit = list.find((a) => (ipInt(a.ip) & ipInt(a.netmask)) === (ipInt(peerIp) & ipInt(a.netmask)));
    if (hit) return hit;
  }
  return list[0] || null;
}

function magicPacket(mac, from) {
  const m = Buffer.from(mac.split(':').map((x) => parseInt(x, 16)));
  const pkt = Buffer.concat([Buffer.alloc(6, 0xff)].concat(Array(16).fill(m)));
  const targets = ['255.255.255.255'];
  if (from) targets.unshift(intIp((ipInt(from.ip) | (~ipInt(from.netmask) >>> 0)) >>> 0));
  const sock = dgram.createSocket('udp4');
  sock.on('error', (e) => log('magic packet: ' + e.message));
  sock.bind(0, from ? from.ip : undefined, () => {
    sock.setBroadcast(true);
    let left = targets.length;
    for (const t of targets) sock.send(pkt, 9, t, () => { if (--left === 0) sock.close(); });
  });
}

// ---- standing in -----------------------------------------------------------

let standIn = null; // { tv, acc, power, hap, ad, store, writes, pairingsChanged, since, wokeAt, timers }
const hostName = 'vetro-relay-' + crypto.randomBytes(3).toString('hex') + '.local';

// The TV's accessory database, rebuilt from its own JSON so every instance id matches.
function buildAccessory(json) {
  const acc = new Accessory();
  const a = json && json[0];
  if (!a || a.aid !== 1 || !Array.isArray(a.services)) throw new Error('bad accessory database');
  const byIid = new Map();
  for (const s of a.services) {
    const svc = acc.addService(s.type, s.iid, { primary: !!s.primary, hidden: !!s.hidden });
    byIid.set(s.iid, svc);
    for (const c of s.characteristics) {
      const made = svc.add(c.type, {
        format: c.format, perms: c.perms, value: c.value, minValue: c.minValue, maxValue: c.maxValue,
        minStep: c.minStep, validValues: c['valid-values'], maxLen: c.maxLen, unit: c.unit,
      });
      if (made.iid !== c.iid) throw new Error('instance id mismatch at ' + c.iid);
    }
  }
  for (const s of a.services) for (const l of s.linked || []) if (byIid.has(l)) byIid.get(s.iid).link(byIid.get(l));
  acc.index();
  if (JSON.stringify(acc.toJSON()[0].services.map((s) => [s.iid, s.characteristics.map((c) => c.iid)]))
    !== JSON.stringify(a.services.map((s) => [s.iid, s.characteristics.map((c) => c.iid)]))) throw new Error('accessory database did not rebuild the same');
  return acc;
}

function wake(si) {
  if (si.wokeAt && Date.now() - si.wokeAt < WAKE_GIVE_UP_MS) return;
  si.wokeAt = Date.now();
  const from = ownAddress(si.tv.ip);
  log('Home turned the TV on: sending magic packets to ' + si.tv.mac);
  for (const ms of WAKE_AT_MS) si.timers.push(setTimeout(() => { if (standIn === si) magicPacket(si.tv.mac, from); }, ms));
  si.timers.push(setTimeout(() => {
    if (standIn !== si) return;
    log('the TV did not come back within ' + (WAKE_GIVE_UP_MS / 1000) + ' s; showing off again');
    si.wokeAt = 0;
    si.acc.update(si.power, 0, null);
  }, WAKE_GIVE_UP_MS));
}

async function start(p, fromIp) {
  if (!p || !p.identity || !p.identity.deviceId || !p.identity.ltsk || !p.identity.ltpk || !p.txt || !p.tv || !/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/i.test(p.tv.mac || '')) throw new Error('incomplete handover');
  if (!Object.keys(p.identity.pairings || {}).length) throw new Error('the TV is not in any home');
  if (standIn) stop('a new handover replaces it');
  const acc = buildAccessory(p.accessories);
  const power = acc.characteristic(1, p.power);
  if (!power) throw new Error('no power characteristic ' + p.power);
  power.value = 0;
  const input = p.input && acc.characteristic(1, p.input.iid);
  if (input) input.value = p.input.value;
  const si = {
    tv: { name: String(p.tv.name || 'TV'), mac: p.tv.mac, ip: p.tv.ip || fromIp, port: p.tv.port || 8099 },
    acc, power, writes: new Map(), pairingsChanged: false, since: Date.now(), wokeAt: 0, timers: [],
  };
  si.store = {
    deviceId: p.identity.deviceId,
    ltsk: Buffer.from(p.identity.ltsk, 'hex'),
    ltpk: Buffer.from(p.identity.ltpk, 'hex'),
    pairings: JSON.parse(JSON.stringify(p.identity.pairings)),
    save() { si.pairingsChanged = true; },
  };
  // Every write is accepted. Power on wakes the TV; the rest is kept for the TV to replay.
  for (const s of acc.services) {
    for (const c of s.characteristics) {
      if (!c.canWrite()) continue;
      c.handle((v) => {
        if (c === power) { if (v === 1) wake(si); return undefined; }
        si.writes.set(c.iid, { iid: c.iid, type: c.type, value: v });
        return undefined;
      });
    }
  }
  si.hap = new HapServer({ accessory: acc, store: si.store, setupCode: '000-00-000', log: (m) => log('homekit: ' + m) });
  si.hap.server.on('error', (e) => log('homekit server error: ' + e.message));
  let port;
  try { port = await si.hap.listen(HAP_PORT); } catch (e) { port = await si.hap.listen(0); }
  const own = ownAddress(si.tv.ip);
  si.ad = mdns.advertise({
    name: si.tv.name + ' Relay', type: '_hap._tcp', port, txt: p.txt, host: hostName, address: own ? own.ip : undefined,
    log: bonjourLog,
  });
  // If a release got lost, notice that the TV has taken HomeKit back.
  si.timers.push(setInterval(() => {
    const req = http.get({ host: si.tv.ip, port: si.tv.port, path: '/plugins/homekit/api/relay', timeout: 1500 }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        try { if (res.statusCode === 200 && JSON.parse(body).handedOver === false && standIn === si) stop('the TV has HomeKit again'); } catch (e) { /* not ours */ }
      });
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => {});
  }, CHECK_TV_MS));
  standIn = si;
  log('standing in for "' + si.tv.name + '" (' + si.tv.ip + ', ' + si.tv.mac + ') on port ' + port + (own ? ' at ' + own.ip : ''));
}

// Stops standing in; returns what the TV needs to know.
function stop(why) {
  const si = standIn;
  if (!si) return { standingIn: false, pairings: null, writes: [], woke: false };
  standIn = null;
  for (const t of si.timers) { clearTimeout(t); clearInterval(t); }
  try { si.ad.stop(); } catch (e) { /* stopped */ }
  try { si.hap.close(); } catch (e) { /* closed */ }
  log('no longer standing in for "' + si.tv.name + '": ' + why);
  return {
    standingIn: true,
    pairings: si.pairingsChanged ? si.store.pairings : null,
    writes: Array.from(si.writes.values()),
    woke: si.wokeAt > 0,
  };
}

// ---- control server ---------------------------------------------------------

const nonces = new Map(); // nonce -> expiry
function newNonce() {
  const now = Date.now();
  for (const [n, t] of nonces) if (t < now) nonces.delete(n);
  if (nonces.size > 200) nonces.clear();
  const n = crypto.randomBytes(16).toString('hex');
  nonces.set(n, now + 60000);
  return n;
}
function useNonce(n) {
  const t = nonces.get(n);
  nonces.delete(n);
  return !!t && t >= Date.now();
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => { size += c.length; if (size > 1048576) req.destroy(); else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const json = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
  const from = (req.socket.remoteAddress || '').replace('::ffff:', '');
  try {
    if (req.method === 'GET' && req.url === '/info') {
      return json(200, { service: link.SERVICE, version: link.VERSION, name: NAME, standingIn: !!standIn, for: standIn ? standIn.tv.name : null });
    }
    if (req.method === 'GET' && req.url === '/nonce') return json(200, { nonce: newNonce() });
    if (req.method !== 'POST' || ['/hello', '/handover', '/release'].indexOf(req.url) < 0) return json(404, { error: 'not found' });
    let msg;
    try { msg = link.open(KEY, await readBody(req)); } catch (e) {
      log('refused ' + req.url + ' from ' + from + ': it was sealed with a different secret');
      return json(403, { error: 'secret' });
    }
    if (!useNonce(msg.nonce)) return json(409, { error: 'stale nonce' });
    let out;
    if (req.url === '/hello') out = { ok: true, version: link.VERSION, name: NAME };
    else if (req.url === '/handover') { await start(msg, from); out = { ok: true }; }
    else out = Object.assign({ ok: true }, stop('the TV took HomeKit back'));
    res.writeHead(200, { 'content-type': 'application/octet-stream' });
    res.end(link.seal(KEY, out));
  } catch (e) {
    log(req.url + ' from ' + from + ' failed: ' + e.message);
    json(400, { error: e.message });
  }
});

// Discovery: the TV broadcasts link.PROBE to this port over UDP; say who and where we are.
const discovery = dgram.createSocket({ type: 'udp4', reuseAddr: true });
discovery.on('error', (e) => log('discovery socket: ' + e.message));
discovery.on('message', (m, rinfo) => {
  if (m.toString('utf8') !== link.PROBE) return;
  const answer = Buffer.from(JSON.stringify({ service: link.SERVICE, version: link.VERSION, name: NAME, port: PORT }));
  discovery.send(answer, rinfo.port, rinfo.address, () => {});
});

server.listen(PORT, () => {
  const own = ownAddress(null);
  log('vetro-homekit relay "' + NAME + '" listening on port ' + PORT + (own ? ' at ' + own.ip : ' (no LAN address found)'));
  discovery.bind(PORT);
});
server.on('error', (e) => { console.error('cannot listen on port ' + PORT + ': ' + e.message); process.exit(1); });

function quit() {
  stop('the relay is shutting down');
  try { discovery.close(); } catch (e) { /* closed */ }
  server.close();
  setTimeout(() => process.exit(0), 300);
}
process.on('SIGTERM', quit);
process.on('SIGINT', quit);
