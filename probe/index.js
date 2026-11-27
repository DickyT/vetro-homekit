'use strict';
// One-off probe: reports the Node runtime, crypto support and mDNS options
// available to a shard. Results show up as `detail` in GET /plugins.

const crypto = require('crypto');
const dgram = require('dgram');
const net = require('net');

module.exports = function (ctx) {
  const r = { done: false };
  const handles = [];

  function feature(name, fn) {
    try { r[name] = fn(); } catch (e) { r[name] = 'ERR ' + e.message; }
  }

  function probeDgram() {
    return new Promise((resolve) => {
      let sock;
      try {
        sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      } catch (e) {
        r.dgram = 'create ERR ' + e.message;
        return resolve();
      }
      handles.push(sock);
      let packets = 0;
      sock.on('error', (e) => { r.dgram = 'ERR ' + e.code + ' ' + e.message; resolve(); });
      sock.on('message', () => { packets++; });
      sock.bind(5353, () => {
        try {
          sock.addMembership('224.0.0.251');
          r.dgram = 'bound+joined';
        } catch (e) {
          r.dgram = 'bound, join ERR ' + e.message;
        }
        setTimeout(() => {
          r.dgramPackets3s = packets;
          try { sock.close(); } catch (e) { /* closed */ }
          resolve();
        }, 3000);
      });
    });
  }

  function probeDnssd(path) {
    return new Promise((resolve) => {
      const out = { path };
      r['dnssd_' + path] = out;
      const s = net.connect(path);
      handles.push(s);
      let buf = Buffer.alloc(0);
      const finish = (why) => { out.result = out.result || why; try { s.destroy(); } catch (e) { /* gone */ } resolve(); };
      const timer = setTimeout(() => finish('timeout, got ' + buf.length + ' bytes: ' + buf.toString('hex')), 4000);
      s.on('error', (e) => { clearTimeout(timer); finish('ERR ' + e.code); });
      s.on('connect', () => {
        out.connected = true;
        const str = (x) => Buffer.from(x + '\0', 'utf8');
        const port = Buffer.alloc(2); port.writeUInt16BE(9, 0);
        const txt = Buffer.from([4, 0x61, 0x3d, 0x62, 0x63]); // "a=bc"
        const txtLen = Buffer.alloc(2); txtLen.writeUInt16BE(txt.length, 0);
        const data = Buffer.concat([
          Buffer.alloc(4), Buffer.alloc(4), // flags, interfaceIndex
          str('VetroProbe'), str('_vetroprobe._tcp'), str(''), str(''),
          port, txtLen, txt,
        ]);
        const hdr = Buffer.alloc(28);
        hdr.writeUInt32BE(1, 0); // version
        hdr.writeUInt32BE(data.length, 4);
        hdr.writeUInt32BE(0, 8); // ipc_flags
        hdr.writeUInt32BE(5, 12); // reg_service_request
        s.write(Buffer.concat([hdr, data]));
      });
      s.on('data', (d) => {
        buf = Buffer.concat([buf, d]);
        if (buf.length >= 4 && out.err === undefined) out.err = buf.readInt32BE(0);
        if (buf.length >= 4 + 28 + 12) {
          out.replyOp = buf.readUInt32BE(4 + 12);
          out.replyErr = buf.readInt32BE(4 + 28 + 8);
          out.replyRest = buf.slice(4 + 28 + 12).toString('utf8').split('\0').filter(Boolean);
          // Keep the registration alive for 20 s so it can be seen with dns-sd -B.
          clearTimeout(timer);
          setTimeout(() => finish('registered'), 20000);
        }
      });
    });
  }

  async function run() {
    feature('node', () => process.version);
    feature('versions', () => ({ openssl: process.versions.openssl, v8: process.versions.v8, uv: process.versions.uv }));
    feature('uid', () => (process.getuid ? process.getuid() : null));
    feature('bigint', () => typeof BigInt === 'function');
    feature('optionalChaining', () => { new Function('var a={}; return a?.b ?? 1')(); return true; });
    feature('asyncAwait', () => { new Function('return async function(){ await 1 }')(); return true; });
    feature('chacha', () => crypto.getCiphers().indexOf('chacha20-poly1305') >= 0);
    feature('chachaRoundTrip', () => {
      const key = crypto.randomBytes(32);
      const iv = crypto.randomBytes(12);
      const c = crypto.createCipheriv('chacha20-poly1305', key, iv, { authTagLength: 16 });
      c.setAAD(Buffer.from([1, 2]), { plaintextLength: 3 });
      const ct = Buffer.concat([c.update(Buffer.from('abc')), c.final()]);
      const tag = c.getAuthTag();
      const d = crypto.createDecipheriv('chacha20-poly1305', key, iv, { authTagLength: 16 });
      d.setAAD(Buffer.from([1, 2]), { plaintextLength: 3 });
      d.setAuthTag(tag);
      return Buffer.concat([d.update(ct), d.final()]).toString() === 'abc';
    });
    feature('ed25519', () => {
      const kp = crypto.generateKeyPairSync('ed25519');
      const sig = crypto.sign(null, Buffer.from('x'), kp.privateKey);
      return crypto.verify(null, Buffer.from('x'), kp.publicKey, sig);
    });
    feature('x25519', () => {
      const a = crypto.generateKeyPairSync('x25519');
      const b = crypto.generateKeyPairSync('x25519');
      const s1 = crypto.diffieHellman({ privateKey: a.privateKey, publicKey: b.publicKey });
      const s2 = crypto.diffieHellman({ privateKey: b.privateKey, publicKey: a.publicKey });
      return s1.equals(s2);
    });
    feature('modp15', () => crypto.getDiffieHellman('modp15').getPrime().length);
    feature('srpSpeedMs', () => {
      const N = BigInt('0x' + crypto.getDiffieHellman('modp15').getPrime('hex'));
      const t = Date.now();
      let res = BigInt(1);
      let b = BigInt(5);
      let e = BigInt('0x' + crypto.randomBytes(64).toString('hex'));
      while (e > BigInt(0)) {
        if (e & BigInt(1)) res = (res * b) % N;
        e >>= BigInt(1);
        b = (b * b) % N;
      }
      return Date.now() - t;
    });
    await probeDgram();
    await Promise.all([probeDnssd('/run/mdnsd'), probeDnssd('/var/run/mdnsd')]);
    r.done = true;
  }

  return {
    start() { run().catch((e) => { r.fatal = String(e && e.stack || e); r.done = true; }); },
    stop() { for (const h of handles) { try { h.destroy ? h.destroy() : h.close(); } catch (e) { /* gone */ } } },
    status() { return r; },
  };
};
