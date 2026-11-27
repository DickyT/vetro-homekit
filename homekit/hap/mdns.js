'use strict';
// Publishes the HAP service over Bonjour. First choice is the TV's own mdnsd
// through its client socket (/run/mdnsd, mDNSResponder IPC), which handles
// probing, conflicts and the TV's host name. If that is unavailable, falls back
// to a small multicast responder of our own on UDP 5353.

const net = require('net');
const dgram = require('dgram');
const os = require('os');

// HK_MDNSD_SOCKET is for tests (for example macOS's /var/run/mDNSResponder, same protocol).
const SOCKET_PATHS = process.env.HK_MDNSD_SOCKET ? [process.env.HK_MDNSD_SOCKET] : ['/run/mdnsd', '/var/run/mdnsd'];
const REG_SERVICE_REQUEST = 5;
const REG_SERVICE_REPLY = 65;

function txtRecord(txt) {
  const parts = [];
  for (const k of Object.keys(txt)) {
    const s = Buffer.from(k + '=' + txt[k], 'utf8');
    parts.push(Buffer.from([s.length]), s);
  }
  return Buffer.concat(parts);
}

function cstr(s) { return Buffer.from(s + '\0', 'utf8'); }

// --- mDNSResponder IPC -------------------------------------------------------

// Marks this module's mdnsd sockets, across reloads of the module.
const SOCKET_TAG = Symbol.for('vetro-homekit.mdns-socket');

// Closes mdnsd registrations an earlier copy of this module left open in this
// process. Vetro reloads a shard inside its own process, so a socket an old
// copy lost track of keeps its service advertised until Vetro restarts.
// Sockets are recognised by the tag, or (made before the tag existed) by this
// module's 'close' handler. Returns how many were closed.
function reapOrphans() {
  const handles = typeof process._getActiveHandles === 'function' ? process._getActiveHandles() : [];
  let closed = 0;
  for (const h of handles) {
    if (!(h instanceof net.Socket) || h.destroyed) continue;
    const ours = h[SOCKET_TAG] === true
      || h.listeners('close').some((f) => String(f).indexOf('mdnsd closed the connection') >= 0);
    if (!ours) continue;
    try { h.destroy(); closed++; } catch (e) { /* gone */ }
  }
  return closed;
}

function registerViaDaemon(socketPath, opts, onLost) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(socketPath);
    sock[SOCKET_TAG] = true;
    let buf = Buffer.alloc(0);
    let gotErr = false;
    let settled = false;
    let registered = false;
    const timer = setTimeout(() => fail(new Error('mdnsd did not answer')), 5000);

    function fail(e) {
      clearTimeout(timer);
      try { sock.destroy(); } catch (x) { /* gone */ }
      if (!settled) { settled = true; reject(e); }
    }

    sock.on('error', (e) => fail(e));
    sock.on('close', () => {
      if (registered) onLost(sock);
      else fail(new Error('mdnsd closed the connection'));
    });
    sock.on('connect', () => {
      const port = Buffer.alloc(2);
      port.writeUInt16BE(opts.port, 0);
      const txt = txtRecord(opts.txt);
      const txtLen = Buffer.alloc(2);
      txtLen.writeUInt16BE(txt.length, 0);
      const data = Buffer.concat([
        Buffer.alloc(4), // flags
        Buffer.alloc(4), // interface index: all
        cstr(opts.name), cstr(opts.type), cstr(''), cstr(''),
        port, txtLen, txt,
      ]);
      const hdr = Buffer.alloc(28);
      hdr.writeUInt32BE(1, 0); // IPC version
      hdr.writeUInt32BE(data.length, 4);
      hdr.writeUInt32BE(0, 8); // ipc flags
      hdr.writeUInt32BE(REG_SERVICE_REQUEST, 12);
      sock.write(Buffer.concat([hdr, data]));
    });
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      if (!gotErr) {
        if (buf.length < 4) return;
        const err = buf.readInt32BE(0);
        buf = buf.slice(4);
        gotErr = true;
        if (err !== 0) return fail(new Error('mdnsd refused the registration: ' + err));
      }
      while (buf.length >= 28) {
        const len = buf.readUInt32BE(4);
        if (buf.length < 28 + len) return;
        const op = buf.readUInt32BE(12);
        const body = buf.slice(28, 28 + len);
        buf = buf.slice(28 + len);
        if (op !== REG_SERVICE_REPLY || body.length < 12) continue;
        const err = body.readInt32BE(8);
        const name = body.slice(12).toString('utf8').split('\0')[0];
        if (err !== 0) return fail(new Error('mdnsd registration error ' + err));
        if (!settled) {
          clearTimeout(timer);
          settled = true;
          registered = true;
          resolve({ sock, name });
        }
      }
    });
  });
}

// --- Fallback multicast responder ---------------------------------------------

const A = 1;
const PTR = 12;
const TXT = 16;
const SRV = 33;
const ANY = 255;
const MDNS_ADDR = '224.0.0.251';

function lanAddress() {
  const ifs = os.networkInterfaces();
  for (const name of Object.keys(ifs)) {
    for (const a of ifs[name] || []) {
      if (a.family === 'IPv4' && !a.internal) return a.address;
    }
  }
  return null;
}

function encodeName(name) {
  const parts = [];
  for (const label of name.split('.').filter(Boolean)) {
    const b = Buffer.from(label, 'utf8');
    parts.push(Buffer.from([b.length]), b);
  }
  parts.push(Buffer.from([0]));
  return Buffer.concat(parts);
}

function readName(msg, offset) {
  const labels = [];
  let off = offset;
  let jumped = false;
  let end = offset;
  for (let guard = 0; guard < 128; guard++) {
    const len = msg[off];
    if (len === undefined) throw new Error('bad name');
    if (len === 0) { if (!jumped) end = off + 1; break; }
    if ((len & 0xc0) === 0xc0) {
      if (!jumped) end = off + 2;
      off = ((len & 0x3f) << 8) | msg[off + 1];
      jumped = true;
      continue;
    }
    labels.push(msg.slice(off + 1, off + 1 + len).toString('utf8'));
    off += 1 + len;
  }
  return { name: labels.join('.'), end };
}

function rr(name, type, flush, ttl, rdata) {
  const head = Buffer.alloc(10);
  head.writeUInt16BE(type, 0);
  head.writeUInt16BE(flush ? 0x8001 : 0x0001, 2);
  head.writeUInt32BE(ttl, 4);
  head.writeUInt16BE(rdata.length, 8);
  return Buffer.concat([encodeName(name), head, rdata]);
}

function packet(id, answers, additionals, question) {
  const h = Buffer.alloc(12);
  h.writeUInt16BE(id || 0, 0);
  h.writeUInt16BE(0x8400, 2); // response, authoritative
  h.writeUInt16BE(question ? 1 : 0, 4);
  h.writeUInt16BE(answers.length, 6);
  h.writeUInt16BE(additionals.length, 10);
  return Buffer.concat([h].concat(question ? [question] : [], answers, additionals));
}

function responder(opts) {
  const log = opts.log;
  const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  // opts.host and opts.address are for a machine with several interfaces
  // (the relay on a NAS): the host name to publish and the address to use.
  const host = opts.host || ('Vetro-' + opts.txt.id.replace(/:/g, '').slice(-6) + '.local');
  const ownIp = () => opts.address || lanAddress();
  const svc = opts.type + '.local';
  const inst = opts.name + '.' + svc;
  let txt = opts.txt;
  let closed = false;

  function records(ttlScale) {
    const ip = ownIp();
    const srv = Buffer.alloc(6);
    srv.writeUInt16BE(0, 0);
    srv.writeUInt16BE(0, 2);
    srv.writeUInt16BE(opts.port, 4);
    const t = ttlScale === 0 ? 0 : 1;
    return {
      ptr: rr(svc, PTR, false, 4500 * t, encodeName(inst)),
      enumPtr: rr('_services._dns-sd._udp.local', PTR, false, 4500 * t, encodeName(svc)),
      srv: rr(inst, SRV, true, 120 * t, Buffer.concat([srv, encodeName(host)])),
      txt: rr(inst, TXT, true, 4500 * t, txtRecord(txt)),
      a: ip ? rr(host, A, true, 120 * t, Buffer.from(ip.split('.').map(Number))) : null,
    };
  }

  function send(buf, port, address) {
    if (closed) return;
    sock.send(buf, 0, buf.length, port || 5353, address || MDNS_ADDR, () => {});
  }

  function announce(goodbye) {
    const r = records(goodbye ? 0 : 1);
    const all = [r.ptr, r.srv, r.txt].concat(r.a ? [r.a] : []);
    send(packet(0, all, []));
  }

  sock.on('error', (e) => log('mdns responder error: ' + e.message));
  sock.on('message', (msg, rinfo) => {
    try {
      if (msg.length < 12 || (msg.readUInt16BE(2) & 0x8000)) return; // ignore responses
      const qd = msg.readUInt16BE(4);
      let off = 12;
      const r = records(1);
      const answers = [];
      const extra = [];
      let firstQuestion = null;
      for (let i = 0; i < qd; i++) {
        const q = readName(msg, off);
        const type = msg.readUInt16BE(q.end);
        if (i === 0) firstQuestion = msg.slice(off, q.end + 4);
        off = q.end + 4;
        const name = q.name.toLowerCase();
        if (name === svc.toLowerCase() && (type === PTR || type === ANY)) {
          answers.push(r.ptr);
          extra.push(r.srv, r.txt);
          if (r.a) extra.push(r.a);
        } else if (name === '_services._dns-sd._udp.local' && (type === PTR || type === ANY)) {
          answers.push(r.enumPtr);
        } else if (name === inst.toLowerCase()) {
          if (type === SRV || type === ANY) answers.push(r.srv);
          if (type === TXT || type === ANY) answers.push(r.txt);
          if (r.a) extra.push(r.a);
        } else if (name === host.toLowerCase() && (type === A || type === ANY) && r.a) {
          answers.push(r.a);
        }
      }
      if (!answers.length) return;
      if (rinfo.port !== 5353) {
        // Legacy unicast query: answer directly, echoing the id and question.
        send(packet(msg.readUInt16BE(0), answers, extra, firstQuestion), rinfo.port, rinfo.address);
      } else {
        send(packet(0, answers, extra));
      }
    } catch (e) { /* malformed packet */ }
  });

  return new Promise((resolve, reject) => {
    sock.once('error', reject);
    sock.bind(5353, () => {
      sock.removeListener('error', reject);
      try {
        const ip = ownIp();
        sock.addMembership(MDNS_ADDR, ip || undefined);
        if (ip) sock.setMulticastInterface(ip);
        sock.setMulticastTTL(255);
      } catch (e) {
        log('mdns join failed: ' + e.message);
      }
      announce(false);
      setTimeout(() => announce(false), 1000);
      resolve({
        host,
        update(newTxt) {
          txt = newTxt;
          announce(false);
          setTimeout(() => announce(false), 1000);
        },
        reannounce() { announce(false); },
        stop() {
          announce(true);
          closed = true;
          setTimeout(() => { try { sock.close(); } catch (e) { /* closed */ } }, 50);
        },
      });
    });
  });
}

// --- Public API ----------------------------------------------------------------

// Returns { update(txt), restart(), stop(), status() } right away; publishing
// happens in the background and is retried if it fails or the daemon drops it.
function advertise(opts) {
  const log = opts.log || function () {};
  let txt = opts.txt;
  let stopped = false;
  let mode = 'starting';
  let detail = null;
  let daemonSock = null;
  let fallback = null;
  let retryTimer = null;
  // Bumped by clear() and by every start(). A registration that completes for
  // an older attempt is closed at once, so at most one is ever live. (Without
  // this, update() during an in-flight registration left the first socket
  // open, and mdnsd kept advertising it until Vetro restarted.)
  let attempt = 0;

  function clear() {
    attempt++;
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
    if (daemonSock) { const s = daemonSock; daemonSock = null; try { s.destroy(); } catch (e) { /* gone */ } }
    if (fallback) { const f = fallback; fallback = null; try { f.stop(); } catch (e) { /* gone */ } }
  }

  function retryLater(ms) {
    if (stopped) return;
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = setTimeout(start, ms);
  }

  async function start() {
    retryTimer = null;
    if (stopped) return;
    const my = ++attempt;
    const current = () => !stopped && my === attempt;
    const o = { name: opts.name, type: opts.type, port: opts.port, txt };
    const errors = [];
    for (const p of SOCKET_PATHS) {
      try {
        const reg = await registerViaDaemon(p, o, (lostSock) => {
          if (daemonSock !== lostSock || stopped) return;
          daemonSock = null;
          log('mdnsd dropped the registration; retrying');
          retryLater(3000);
        });
        if (!current()) { reg.sock.destroy(); return; }
        daemonSock = reg.sock;
        mode = 'mdnsd';
        detail = { socket: p, name: reg.name };
        log('published "' + reg.name + '" via ' + p);
        return;
      } catch (e) {
        errors.push(p + ': ' + e.message);
      }
      if (!current()) return;
    }
    log('mdnsd unavailable (' + errors.join('; ') + '); using own responder');
    try {
      const f = await responder({ name: opts.name, type: opts.type, port: opts.port, txt, log, host: opts.host, address: opts.address });
      if (!current()) { f.stop(); return; }
      fallback = f;
      mode = 'responder';
      detail = { host: fallback.host, mdnsdErrors: errors };
      log('own mDNS responder up as ' + fallback.host);
    } catch (e) {
      if (!current()) return;
      mode = 'failed';
      detail = { errors: errors.concat('responder: ' + e.message) };
      log('mDNS publishing failed: ' + e.message + '; retrying in 30 s');
      retryLater(30000);
    }
  }

  // Only one advertiser runs per shard, and the previous one was stopped
  // before this one starts, so any of our sockets still open are orphans.
  const reaped = reapOrphans();
  if (reaped) log('closed ' + reaped + ' leftover Bonjour registration(s) from an earlier run');
  start();

  return {
    // New TXT (for example sf after pairing). The daemon path re-registers,
    // because updating a record needs a second socket Node cannot pass.
    update(newTxt) {
      txt = newTxt;
      if (fallback) { fallback.update(txt); return; }
      clear();
      retryLater(500);
    },
    restart() {
      if (fallback) { fallback.reannounce(); return; }
      clear();
      retryLater(500);
    },
    stop() {
      stopped = true;
      clear();
    },
    status() { return { mode, detail }; },
  };
}

module.exports = { advertise, registerViaDaemon };
