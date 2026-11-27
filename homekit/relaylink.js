'use strict';
// The link between the TV plugin and the relay (relay/relay.js), used by both.
//
// The relay stands in for the TV in HomeKit while the TV is in full sleep.
// The TV hands its HomeKit identity over when it powers off and takes it back
// when it is lit again:
//
//   GET  /info      -> { service, version, standingIn, for }   (no secrets)
//   GET  /nonce     -> { nonce }   one use, valid for a minute
//   POST /hello     sealed { nonce }                -> sealed { ok, version }
//   POST /handover  sealed { nonce, ...identity }   -> sealed { ok }
//   POST /release   sealed { nonce }                -> sealed { ok, standingIn, pairings, writes, woke }
//
// "Sealed" is ChaCha20-Poly1305 with a key made from the shared secret
// (scrypt): 12 random nonce bytes, then ciphertext and tag. A wrong secret
// fails to open and is answered with 403. The nonce from /nonce inside every
// sealed request stops a recorded request from being played again.
//
// The relay is found with a UDP broadcast on the control port: the TV sends
// PROBE, every relay on the subnet answers with its name and port. So neither
// side needs a fixed address. (Bonjour was tried first: on some Wi-Fi networks
// a query from a port other than 5353 is not passed on to other clients.) A
// relay on another subnet, or on a port other than 8125, needs its address
// typed into the settings page.

const crypto = require('crypto');
const dgram = require('dgram');
const http = require('http');
const hc = require('./hap/crypto');

const os = require('os');

const SERVICE = 'vetro-homekit-relay';
const PROBE = 'vetro-homekit-relay?';
const VERSION = 1;
const DEFAULT_PORT = 8125;

function key(secret) {
  return crypto.scryptSync(String(secret), 'vetro-homekit-relay-v1', 32);
}

function seal(k, obj) {
  const nonce = crypto.randomBytes(12);
  return Buffer.concat([nonce, hc.seal(k, nonce, Buffer.from(JSON.stringify(obj), 'utf8'))]);
}

// Throws if the secret differs or the bytes were changed.
function open(k, buf) {
  if (!buf || buf.length < 28) throw new Error('sealed message too short');
  return JSON.parse(hc.open(k, buf.slice(0, 12), buf.slice(12)).toString('utf8'));
}

// ---- HTTP client (the TV side) ---------------------------------------------

// target: { ip, port }. Resolves { status, body (Buffer) }.
function request(target, method, path, body, ms) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: target.ip, port: target.port || DEFAULT_PORT, method, path,
      headers: body ? { 'content-type': 'application/octet-stream', 'content-length': body.length } : {},
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    req.on('error', (e) => reject(new Error('relay not reachable at ' + target.ip + ':' + (target.port || DEFAULT_PORT) + ' (' + (e.code || e.message) + ')')));
    req.setTimeout(ms || 6000, () => req.destroy(new Error('timeout')));
    if (body) req.write(body);
    req.end();
  });
}

function info(target) {
  return request(target, 'GET', '/info', null, 4000).then((r) => {
    if (r.status !== 200) throw new Error('relay answered ' + r.status);
    return JSON.parse(r.body.toString('utf8'));
  });
}

// One sealed request: fetches a nonce, sends `obj` with it, opens the answer.
// An error's `code` is 'secret' when the relay could not open the request.
async function call(target, k, path, obj) {
  const n = await request(target, 'GET', '/nonce', null, 4000);
  if (n.status !== 200) throw new Error('relay answered ' + n.status + ' to /nonce');
  const nonce = JSON.parse(n.body.toString('utf8')).nonce;
  const r = await request(target, 'POST', path, seal(k, Object.assign({ nonce }, obj)), 10000);
  if (r.status === 403) {
    const e = new Error('the relay has a different secret');
    e.code = 'secret';
    throw e;
  }
  if (r.status !== 200) throw new Error('relay answered ' + r.status + ': ' + r.body.toString('utf8').slice(0, 120));
  return open(k, r.body);
}

// ---- Finding the relay -------------------------------------------------------

const ipInt = (ip) => ip.split('.').reduce((a, b) => ((a * 256) + Number(b)) >>> 0, 0);
const intIp = (n) => [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');

// Where a broadcast must go to reach every machine on this one's subnets.
function broadcastAddresses() {
  const out = ['255.255.255.255'];
  const all = os.networkInterfaces();
  for (const name of Object.keys(all)) {
    for (const a of all[name] || []) {
      if ((a.family === 'IPv4' || a.family === 4) && !a.internal && a.netmask) {
        const b = intIp((ipInt(a.address) | (~ipInt(a.netmask) >>> 0)) >>> 0);
        if (out.indexOf(b) < 0) out.push(b);
      }
    }
  }
  return out;
}

// Relays on this subnet: [{ name, ip, port }]. `port` is the control port they listen on.
function find(ms, port) {
  return new Promise((resolve) => {
    const sock = dgram.createSocket('udp4');
    const found = [];
    let done = false;
    const finish = () => { if (done) return; done = true; try { sock.close(); } catch (e) { /* closed */ } resolve(found); };
    sock.on('error', finish);
    sock.on('message', (m, rinfo) => {
      try {
        const r = JSON.parse(m.toString('utf8'));
        if (r.service !== SERVICE || found.some((f) => f.ip === rinfo.address && f.port === r.port)) return;
        found.push({ name: String(r.name || rinfo.address).slice(0, 60), ip: rinfo.address, port: parseInt(r.port, 10) || DEFAULT_PORT });
      } catch (e) { /* not a relay */ }
    });
    sock.bind(0, () => {
      try { sock.setBroadcast(true); } catch (e) { /* sends below fail and nothing is found */ }
      const probe = () => { if (!done) for (const a of broadcastAddresses()) sock.send(PROBE, port || DEFAULT_PORT, a, () => {}); };
      probe();
      setTimeout(probe, 300);
    });
    setTimeout(finish, ms || 1200);
  });
}

// "host" or "host:port" from the settings page -> { ip, port }, or null.
function parseAddress(text) {
  const m = /^\s*([A-Za-z0-9.-]+)(?::(\d{1,5}))?\s*$/.exec(String(text || ''));
  if (!m) return null;
  return { ip: m[1], port: m[2] ? parseInt(m[2], 10) : DEFAULT_PORT };
}

module.exports = { SERVICE, PROBE, VERSION, DEFAULT_PORT, key, seal, open, request, info, call, find, parseAddress };
