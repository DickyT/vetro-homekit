'use strict';
// HAP over IP: a TCP server speaking HTTP/1.1, the pair-setup / pair-verify
// handshakes, the encrypted session framing, and the accessory endpoints.

const net = require('net');
const EventEmitter = require('events');
const tlv = require('./tlv');
const hc = require('./crypto');
const SrpServer = require('./srp').SrpServer;
const Status = require('./accessory').Status;

const T = tlv.T;
const E = tlv.E;
const MAX_FRAME = 1024;
const WRITE_TIMEOUT_MS = 9000;
const REASON = {
  200: 'OK', 204: 'No Content', 207: 'Multi-Status', 400: 'Bad Request',
  404: 'Not Found', 405: 'Method Not Allowed', 422: 'Unprocessable Entity',
  470: 'Connection Authorization Required', 500: 'Internal Server Error',
};

function withTimeout(promise, ms) {
  let timer;
  return Promise.race([
    promise,
    new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error('timeout'), { status: Status.Timeout })), ms);
    }),
  ]).then((v) => { clearTimeout(timer); return v; }, (e) => { clearTimeout(timer); throw e; });
}

// store: { deviceId, ltsk, ltpk (Buffers), pairings: { id: { pub: hex, admin: bool } }, save() }
class HapServer extends EventEmitter {
  constructor(opts) {
    super();
    this.accessory = opts.accessory;
    this.store = opts.store;
    this.setupCode = opts.setupCode;
    this.log = opts.log || function () {};
    this.onIdentify = opts.onIdentify || function () {};
    this.connections = new Set();
    // The last requests from controllers: when, who, and what was asked for.
    // Shows what a home hub keeps asking. Paths and ids only, never bodies.
    this.recent = [];
    this.setupOwner = null;
    this.failedSetups = 0;
    // While false, new connections are hung up on at once (see setAccepting).
    this.accepting = true;
    this.server = net.createServer((socket) => {
      if (!this.accepting) { socket.destroy(); return; }
      this.connections.add(new Connection(this, socket));
    });
    this.accessory.on('change', (ch) => {
      for (const c of this.connections) c.queueEvent(ch);
    });
  }

  listen(port) {
    return new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(port || 0, () => {
        this.server.removeListener('error', reject);
        resolve(this.server.address().port);
      });
    });
  }

  close() {
    for (const c of this.connections) c.socket.destroy();
    this.server.close();
  }

  // Hangs up on every controller but keeps listening (they find the accessory
  // again through Bonjour).
  dropConnections() {
    for (const c of this.connections) c.socket.destroy();
  }

  // false: hang up on everyone and turn new connections away, so controllers
  // that still remember this address go and look the accessory up again
  // (the relay answers for it). true: back to normal.
  setAccepting(on) {
    this.accepting = !!on;
    if (!on) this.dropConnections();
  }

  isPaired() {
    return Object.keys(this.store.pairings).length > 0;
  }

  addPairing(id, pub, admin) {
    const wasPaired = this.isPaired();
    this.store.pairings[id] = { pub: pub.toString('hex'), admin: !!admin };
    this.store.save();
    if (!wasPaired) this.emit('paired', true);
  }

  removePairing(id) {
    delete this.store.pairings[id];
    this.store.save();
    for (const c of this.connections) if (c.controllerId === id) c.closeAfterReply = true;
    if (!this.isPaired()) {
      for (const c of this.connections) c.closeAfterReply = true;
      this.emit('paired', false);
    }
  }

  resetPairings() {
    this.store.pairings = {};
    this.store.save();
    for (const c of this.connections) c.socket.destroy();
    this.emit('paired', false);
  }

  note(remote, req) {
    const acc = this.accessory;
    const name = (aid, iid) => {
      const c = acc.characteristic(parseInt(aid, 10), parseInt(iid, 10));
      return aid + '.' + iid + (c ? '(' + c.type + ')' : '(?)');
    };
    let what = req.method + ' ' + req.path;
    try {
      if (req.path === '/characteristics' && req.method === 'GET') {
        what += ' ' + String(req.query.id || '').split(',').filter(Boolean).map((p) => name.apply(null, p.split('.'))).join(',');
      } else if (req.path === '/characteristics' && req.method === 'PUT') {
        what += ' ' + (JSON.parse(req.body.toString('utf8')).characteristics || []).map((i) =>
          name(i.aid, i.iid) + (i.ev === undefined ? '' : ':ev=' + i.ev) + (i.value === undefined ? '' : ':write')).join(',');
      }
    } catch (e) { what += ' (unreadable)'; }
    this.recent.push({ at: Date.now(), from: remote, what: what.slice(0, 400) });
    if (this.recent.length > 80) this.recent.shift();
  }

  controllerCount() {
    let n = 0;
    for (const c of this.connections) if (c.verified) n++;
    return n;
  }
}

class Connection {
  constructor(server, socket) {
    this.server = server;
    this.socket = socket;
    this.raw = Buffer.alloc(0);
    this.plain = Buffer.alloc(0);
    this.encrypted = false;
    this.readKey = null;
    this.writeKey = null;
    this.readCount = 0;
    this.writeCount = 0;
    this.verified = false;
    this.controllerId = null;
    this.admin = false;
    this.subscriptions = new Set();
    this.pendingEvents = new Map();
    this.eventTimer = null;
    this.busy = false;
    this.closeAfterReply = false;
    this.srp = null;
    this.srpKey = null;
    this.pv = null;
    this.remote = socket.remoteAddress + ':' + socket.remotePort;
    socket.setNoDelay(true);
    socket.setKeepAlive(true, 60000);
    socket.on('data', (d) => this.onData(d));
    socket.on('error', () => {});
    socket.on('close', () => {
      server.connections.delete(this);
      if (server.setupOwner === this) server.setupOwner = null;
      if (this.eventTimer) clearTimeout(this.eventTimer);
    });
  }

  onData(d) {
    if (this.encrypted) {
      this.raw = Buffer.concat([this.raw, d]);
      while (this.raw.length >= 2) {
        const len = this.raw.readUInt16LE(0);
        if (this.raw.length < 2 + len + 16) break;
        const aad = this.raw.slice(0, 2);
        const sealed = this.raw.slice(2, 2 + len + 16);
        this.raw = this.raw.slice(2 + len + 16);
        let pt;
        try {
          pt = hc.open(this.readKey, hc.counterNonce(this.readCount++), sealed, aad);
        } catch (e) {
          this.server.log('decrypt failed from ' + this.remote + ', closing');
          this.socket.destroy();
          return;
        }
        this.plain = Buffer.concat([this.plain, pt]);
      }
    } else {
      this.plain = Buffer.concat([this.plain, d]);
    }
    this.pump();
  }

  // Handles buffered requests one at a time, in order.
  pump() {
    if (this.busy) return;
    const req = this.parseRequest();
    if (!req) return;
    this.busy = true;
    this.server.note(this.remote, req);
    Promise.resolve()
      .then(() => this.route(req))
      .catch((e) => {
        this.server.log('request ' + req.method + ' ' + req.path + ' failed: ' + (e && e.stack || e));
        this.reply(500, 'application/hap+json', Buffer.from(JSON.stringify({ status: Status.CommunicationFailure })));
      })
      .then(() => {
        this.busy = false;
        if (this.closeAfterReply) {
          this.socket.end();
          return;
        }
        this.flushEvents();
        this.pump();
      });
  }

  parseRequest() {
    const end = this.plain.indexOf('\r\n\r\n');
    if (end < 0) return null;
    const lines = this.plain.slice(0, end).toString('latin1').split('\r\n');
    const first = lines[0].split(' ');
    const headers = {};
    for (let i = 1; i < lines.length; i++) {
      const p = lines[i].indexOf(':');
      if (p > 0) headers[lines[i].slice(0, p).trim().toLowerCase()] = lines[i].slice(p + 1).trim();
    }
    const len = parseInt(headers['content-length'] || '0', 10) || 0;
    if (this.plain.length < end + 4 + len) return null;
    const body = this.plain.slice(end + 4, end + 4 + len);
    this.plain = this.plain.slice(end + 4 + len);
    const target = first[1] || '/';
    const q = target.indexOf('?');
    const query = {};
    if (q >= 0) {
      for (const kv of target.slice(q + 1).split('&')) {
        const eq = kv.indexOf('=');
        if (eq > 0) query[decodeURIComponent(kv.slice(0, eq))] = decodeURIComponent(kv.slice(eq + 1));
        else if (kv) query[decodeURIComponent(kv)] = '';
      }
    }
    return { method: first[0], path: q >= 0 ? target.slice(0, q) : target, query, headers, body };
  }

  write(buf) {
    if (this.socket.destroyed) return;
    if (!this.encrypted) {
      this.socket.write(buf);
      return;
    }
    for (let off = 0; off < buf.length; off += MAX_FRAME) {
      const chunk = buf.slice(off, off + MAX_FRAME);
      const aad = Buffer.alloc(2);
      aad.writeUInt16LE(chunk.length, 0);
      const sealed = hc.seal(this.writeKey, hc.counterNonce(this.writeCount++), chunk, aad);
      this.socket.write(Buffer.concat([aad, sealed]));
    }
  }

  reply(code, type, body) {
    const head = ['HTTP/1.1 ' + code + ' ' + (REASON[code] || '')];
    if (body && body.length) head.push('Content-Type: ' + type);
    head.push('Content-Length: ' + (body ? body.length : 0));
    this.write(Buffer.concat([Buffer.from(head.join('\r\n') + '\r\n\r\n', 'latin1'), body || Buffer.alloc(0)]));
  }

  replyTlv(items) {
    this.reply(200, 'application/pairing+tlv8', tlv.encode(items));
  }

  replyJson(code, obj) {
    this.reply(code, 'application/hap+json', Buffer.from(JSON.stringify(obj)));
  }

  queueEvent(ch) {
    if (ch.origin === this || !this.verified) return;
    const key = ch.aid + '.' + ch.iid;
    if (!this.subscriptions.has(key)) return;
    this.pendingEvents.set(key, { aid: ch.aid, iid: ch.iid, value: ch.value });
    if (!this.eventTimer) this.eventTimer = setTimeout(() => this.flushEvents(), 100);
  }

  // Events wait while a request is in flight so they never land between a
  // request and its response.
  flushEvents() {
    if (this.busy || !this.pendingEvents.size) return;
    if (this.eventTimer) {
      clearTimeout(this.eventTimer);
      this.eventTimer = null;
    }
    const body = Buffer.from(JSON.stringify({ characteristics: Array.from(this.pendingEvents.values()) }));
    this.pendingEvents.clear();
    const head = 'EVENT/1.0 200 OK\r\nContent-Type: application/hap+json\r\nContent-Length: ' + body.length + '\r\n\r\n';
    this.write(Buffer.concat([Buffer.from(head, 'latin1'), body]));
  }

  route(req) {
    const key = req.method + ' ' + req.path;
    if (key === 'POST /pair-setup') return this.pairSetup(tlv.decode(req.body));
    if (key === 'POST /pair-verify') return this.pairVerify(tlv.decode(req.body));
    if (key === 'POST /identify') return this.identify();
    if (!this.verified) return this.replyJson(470, { status: Status.InsufficientPrivileges });
    if (key === 'GET /accessories') return this.replyJson(200, { accessories: this.server.accessory.toJSON() });
    if (key === 'GET /characteristics') return this.getCharacteristics(req.query);
    if (key === 'PUT /characteristics') return this.putCharacteristics(req.body);
    if (key === 'PUT /prepare') return this.replyJson(200, { status: Status.OK });
    if (key === 'POST /pairings') return this.pairings(tlv.decode(req.body));
    return this.replyJson(404, { status: Status.ResourceDoesNotExist });
  }

  identify() {
    if (this.server.isPaired()) return this.replyJson(400, { status: Status.InsufficientPrivileges });
    this.server.onIdentify();
    return this.reply(204);
  }

  pairSetup(req) {
    const srv = this.server;
    const store = srv.store;
    const state = req[T.State] ? req[T.State][0] : 0;
    const fail = (st, err) => {
      if (srv.setupOwner === this) srv.setupOwner = null;
      this.srp = null;
      this.srpKey = null;
      return this.replyTlv([[T.State, st], [T.Error, err]]);
    };

    if (state === 1) {
      if (srv.isPaired()) return fail(2, E.Unavailable);
      if (srv.failedSetups >= 100) return fail(2, E.MaxTries);
      if (srv.setupOwner && srv.setupOwner !== this && !srv.setupOwner.socket.destroyed) return fail(2, E.Busy);
      srv.setupOwner = this;
      this.srp = new SrpServer('Pair-Setup', srv.setupCode);
      srv.log('pair-setup started by ' + this.remote);
      return this.replyTlv([[T.State, 2], [T.Salt, this.srp.salt], [T.PublicKey, this.srp.Bbuf]]);
    }

    if (state === 3) {
      if (!this.srp || !req[T.PublicKey] || !req[T.Proof]) return fail(4, E.Authentication);
      const r = this.srp.verify(req[T.PublicKey], req[T.Proof]);
      if (!r) {
        srv.failedSetups++;
        srv.log('pair-setup: wrong setup code from ' + this.remote);
        return fail(4, E.Authentication);
      }
      this.srpKey = r.K;
      return this.replyTlv([[T.State, 4], [T.Proof, r.M2]]);
    }

    if (state === 5) {
      const K = this.srpKey;
      if (!K || !req[T.EncryptedData]) return fail(6, E.Authentication);
      const key = hc.hkdf(K, 'Pair-Setup-Encrypt-Salt', 'Pair-Setup-Encrypt-Info');
      let sub;
      try {
        sub = tlv.decode(hc.open(key, hc.labelNonce('PS-Msg05'), req[T.EncryptedData]));
      } catch (e) {
        return fail(6, E.Authentication);
      }
      const iosId = sub[T.Identifier];
      const iosLtpk = sub[T.PublicKey];
      const iosSig = sub[T.Signature];
      if (!iosId || !iosLtpk || !iosSig) return fail(6, E.Authentication);
      const iosX = hc.hkdf(K, 'Pair-Setup-Controller-Sign-Salt', 'Pair-Setup-Controller-Sign-Info');
      if (!hc.edVerify(iosLtpk, Buffer.concat([iosX, iosId, iosLtpk]), iosSig)) return fail(6, E.Authentication);

      srv.addPairing(iosId.toString('utf8'), iosLtpk, true);

      const accX = hc.hkdf(K, 'Pair-Setup-Accessory-Sign-Salt', 'Pair-Setup-Accessory-Sign-Info');
      const accId = Buffer.from(store.deviceId, 'utf8');
      const sig = hc.edSign(store.ltsk, Buffer.concat([accX, accId, store.ltpk]));
      const enc = hc.seal(key, hc.labelNonce('PS-Msg06'), tlv.encode([
        [T.Identifier, accId], [T.PublicKey, store.ltpk], [T.Signature, sig],
      ]));
      srv.setupOwner = null;
      this.srp = null;
      this.srpKey = null;
      srv.log('paired with controller ' + iosId.toString('utf8'));
      return this.replyTlv([[T.State, 6], [T.EncryptedData, enc]]);
    }

    return fail(state + 1, E.Unknown);
  }

  pairVerify(req) {
    const store = this.server.store;
    const state = req[T.State] ? req[T.State][0] : 0;
    const fail = (st) => {
      this.pv = null;
      return this.replyTlv([[T.State, st], [T.Error, E.Authentication]]);
    };

    if (state === 1) {
      const iosPub = req[T.PublicKey];
      if (!iosPub || iosPub.length !== 32) return fail(2);
      const kp = hc.xKeyPair();
      const shared = hc.xShared(kp.priv, iosPub);
      const accId = Buffer.from(store.deviceId, 'utf8');
      const sig = hc.edSign(store.ltsk, Buffer.concat([kp.pub, accId, iosPub]));
      const key = hc.hkdf(shared, 'Pair-Verify-Encrypt-Salt', 'Pair-Verify-Encrypt-Info');
      const enc = hc.seal(key, hc.labelNonce('PV-Msg02'), tlv.encode([[T.Identifier, accId], [T.Signature, sig]]));
      this.pv = { shared, key, accPub: kp.pub, iosPub };
      return this.replyTlv([[T.State, 2], [T.PublicKey, kp.pub], [T.EncryptedData, enc]]);
    }

    if (state === 3) {
      const pv = this.pv;
      if (!pv || !req[T.EncryptedData]) return fail(4);
      let sub;
      try {
        sub = tlv.decode(hc.open(pv.key, hc.labelNonce('PV-Msg03'), req[T.EncryptedData]));
      } catch (e) {
        return fail(4);
      }
      if (!sub[T.Identifier] || !sub[T.Signature]) return fail(4);
      const iosId = sub[T.Identifier].toString('utf8');
      const p = store.pairings[iosId];
      if (!p) return fail(4);
      const info = Buffer.concat([pv.iosPub, sub[T.Identifier], pv.accPub]);
      if (!hc.edVerify(Buffer.from(p.pub, 'hex'), info, sub[T.Signature])) return fail(4);

      this.replyTlv([[T.State, 4]]); // still in plaintext
      this.readKey = hc.hkdf(pv.shared, 'Control-Salt', 'Control-Write-Encryption-Key');
      this.writeKey = hc.hkdf(pv.shared, 'Control-Salt', 'Control-Read-Encryption-Key');
      this.encrypted = true;
      this.verified = true;
      this.controllerId = iosId;
      this.admin = p.admin;
      this.pv = null;
      this.server.log('controller ' + iosId + ' connected from ' + this.remote);
      return undefined;
    }

    return fail(state + 1);
  }

  pairings(req) {
    const srv = this.server;
    const method = req[T.Method] ? req[T.Method][0] : -1;
    if (!this.admin) return this.replyTlv([[T.State, 2], [T.Error, E.Authentication]]);

    if (method === 3) { // add
      const id = req[T.Identifier] && req[T.Identifier].toString('utf8');
      const pub = req[T.PublicKey];
      if (!id || !pub) return this.replyTlv([[T.State, 2], [T.Error, E.Unknown]]);
      const existing = srv.store.pairings[id];
      if (existing && existing.pub !== pub.toString('hex')) return this.replyTlv([[T.State, 2], [T.Error, E.Unknown]]);
      const perm = req[T.Permissions] ? req[T.Permissions][0] : 0;
      srv.addPairing(id, pub, perm === 1);
      srv.log('added pairing ' + id + (perm === 1 ? ' (admin)' : ''));
      return this.replyTlv([[T.State, 2]]);
    }

    if (method === 4) { // remove
      const id = req[T.Identifier] && req[T.Identifier].toString('utf8');
      if (id && srv.store.pairings[id]) {
        srv.removePairing(id);
        srv.log('removed pairing ' + id);
      }
      return this.replyTlv([[T.State, 2]]);
    }

    if (method === 5) { // list
      const items = [[T.State, 2]];
      const ids = Object.keys(srv.store.pairings);
      ids.forEach((id, i) => {
        const p = srv.store.pairings[id];
        if (i > 0) items.push([T.Separator, Buffer.alloc(0)]);
        items.push([T.Identifier, id], [T.PublicKey, Buffer.from(p.pub, 'hex')], [T.Permissions, p.admin ? 1 : 0]);
      });
      return this.replyTlv(items);
    }

    return this.replyTlv([[T.State, 2], [T.Error, E.Unknown]]);
  }

  getCharacteristics(query) {
    const acc = this.server.accessory;
    const ids = (query.id || '').split(',').filter(Boolean);
    const want = (k) => query[k] === '1' || query[k] === 'true';
    let failed = false;
    const out = ids.map((pair) => {
      const parts = pair.split('.');
      const aid = parseInt(parts[0], 10);
      const iid = parseInt(parts[1], 10);
      const c = acc.characteristic(aid, iid);
      if (!c) { failed = true; return { aid, iid, status: Status.ResourceDoesNotExist }; }
      if (!c.canRead()) { failed = true; return { aid, iid, status: Status.WriteOnly }; }
      const r = { aid, iid, value: c.value };
      if (want('meta') || want('perms') || want('type')) {
        const full = c.toJSON(false);
        if (want('type')) r.type = full.type;
        if (want('perms')) r.perms = full.perms;
        if (want('meta')) {
          for (const k of ['format', 'unit', 'minValue', 'maxValue', 'minStep', 'maxLen']) if (full[k] !== undefined) r[k] = full[k];
        }
      }
      if (want('ev')) r.ev = this.subscriptions.has(aid + '.' + iid);
      return r;
    });
    if (failed) {
      for (const r of out) if (r.status === undefined) r.status = Status.OK;
      return this.replyJson(207, { characteristics: out });
    }
    return this.replyJson(200, { characteristics: out });
  }

  async putCharacteristics(body) {
    const acc = this.server.accessory;
    let list;
    try {
      list = JSON.parse(body.toString('utf8')).characteristics;
    } catch (e) {
      return this.replyJson(400, { status: Status.InvalidValue });
    }
    if (!Array.isArray(list)) return this.replyJson(400, { status: Status.InvalidValue });
    const results = [];
    let anyFailed = false;
    let anyResponse = false;
    for (const item of list) {
      const c = acc.characteristic(item.aid, item.iid);
      const r = { aid: item.aid, iid: item.iid, status: Status.OK };
      results.push(r);
      if (!c) { r.status = Status.ResourceDoesNotExist; anyFailed = true; continue; }
      if (item.ev !== undefined) {
        if (!c.canNotify()) { r.status = Status.NotificationNotSupported; anyFailed = true; continue; }
        const key = item.aid + '.' + item.iid;
        if (item.ev) {
          this.subscriptions.add(key);
          if (acc.pushOnSubscribe.has(item.iid)) this.queueEvent({ aid: item.aid, iid: item.iid, value: c.value, origin: null });
        } else {
          this.subscriptions.delete(key);
        }
      }
      if (item.value !== undefined) {
        this.server.log('write ' + item.aid + '.' + item.iid + '=' + JSON.stringify(item.value).slice(0, 60)
          + ' by ' + (this.controllerId || '?').slice(0, 8));
        try {
          await withTimeout(acc.write(c, item.value, this), WRITE_TIMEOUT_MS);
          if (item.r && c.canRead()) { r.value = c.value; anyResponse = true; }
        } catch (e) {
          r.status = typeof e.status === 'number' ? e.status : Status.CommunicationFailure;
          anyFailed = true;
          this.server.log('write ' + item.aid + '.' + item.iid + '=' + JSON.stringify(item.value) + ' failed: ' + (e.message || e));
        }
      }
    }
    if (!anyFailed && !anyResponse) return this.reply(204);
    return this.replyJson(207, { characteristics: results });
  }
}

module.exports = { HapServer };
