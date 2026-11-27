'use strict';
// Minimal HAP controller for testing the shard from a Mac, without an iPhone.
//
//   node test/controller.js <host> <port> pair <setup-code>
//   node test/controller.js <host> <port> accessories
//   node test/controller.js <host> <port> get 1.11 1.12
//   node test/controller.js <host> <port> set 1.12=3 1.15=4
//   node test/controller.js <host> <port> watch <seconds>
//   node test/controller.js <host> <port> unpair
//
// The controller's own keys and the accessory's public key are kept in
// test/.pairing-<host>-<port>.json.

const net = require('net');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const tlv = require('../homekit/hap/tlv');
const hc = require('../homekit/hap/crypto');
const SrpClient = require('../homekit/hap/srp').SrpClient;

const T = tlv.T;
const [host, portStr, cmd, ...args] = process.argv.slice(2);
const port = parseInt(portStr, 10);
const pairingFile = path.join(__dirname, '.pairing-' + host + '-' + port + '.json');

class Session {
  constructor(socket) {
    this.socket = socket;
    this.buf = Buffer.alloc(0);
    this.enc = null;
    this.waiters = [];
    this.onEvent = null;
    socket.on('data', (d) => this.onData(d));
  }

  onData(d) {
    if (this.enc) {
      this.raw = Buffer.concat([this.raw || Buffer.alloc(0), d]);
      while (this.raw.length >= 2) {
        const len = this.raw.readUInt16LE(0);
        if (this.raw.length < 2 + len + 16) break;
        const aad = this.raw.slice(0, 2);
        const pt = hc.open(this.enc.readKey, hc.counterNonce(this.enc.readCount++), this.raw.slice(2, 2 + len + 16), aad);
        this.raw = this.raw.slice(2 + len + 16);
        this.buf = Buffer.concat([this.buf, pt]);
      }
    } else {
      this.buf = Buffer.concat([this.buf, d]);
    }
    for (;;) {
      const end = this.buf.indexOf('\r\n\r\n');
      if (end < 0) return;
      const head = this.buf.slice(0, end).toString('latin1');
      const m = /content-length:\s*(\d+)/i.exec(head);
      const len = m ? parseInt(m[1], 10) : 0;
      if (this.buf.length < end + 4 + len) return;
      const body = this.buf.slice(end + 4, end + 4 + len);
      this.buf = this.buf.slice(end + 4 + len);
      const status = parseInt(head.split(' ')[1], 10);
      if (head.startsWith('EVENT/')) {
        if (this.onEvent) this.onEvent(JSON.parse(body.toString()));
        continue;
      }
      const w = this.waiters.shift();
      if (w) w({ status, head, body });
    }
  }

  request(method, url, type, body) {
    const b = body || Buffer.alloc(0);
    const head = method + ' ' + url + ' HTTP/1.1\r\nHost: ' + host + ':' + port + '\r\n'
      + (b.length ? 'Content-Type: ' + type + '\r\n' : '') + 'Content-Length: ' + b.length + '\r\n\r\n';
    const msg = Buffer.concat([Buffer.from(head, 'latin1'), b]);
    if (this.enc) {
      for (let off = 0; off < msg.length; off += 1024) {
        const chunk = msg.slice(off, off + 1024);
        const aad = Buffer.alloc(2);
        aad.writeUInt16LE(chunk.length, 0);
        this.socket.write(Buffer.concat([aad, hc.seal(this.enc.writeKey, hc.counterNonce(this.enc.writeCount++), chunk, aad)]));
      }
    } else {
      this.socket.write(msg);
    }
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  tlvPost(url, items) {
    return this.request('POST', url, 'application/pairing+tlv8', tlv.encode(items)).then((r) => {
      const d = tlv.decode(r.body);
      if (d[T.Error]) throw new Error(url + ' error ' + d[T.Error][0] + ' at state ' + (d[T.State] && d[T.State][0]));
      return d;
    });
  }
}

function connect() {
  return new Promise((resolve, reject) => {
    const s = net.connect(port, host, () => resolve(new Session(s)));
    s.on('error', reject);
  });
}

async function pair(code) {
  const s = await connect();
  const t0 = Date.now();
  const m2 = await s.tlvPost('/pair-setup', [[T.State, 1], [T.Method, 0]]);
  console.log('M2 in', Date.now() - t0, 'ms');
  const srp = new SrpClient('Pair-Setup', code, m2[T.Salt], m2[T.PublicKey]);
  const t1 = Date.now();
  const m4 = await s.tlvPost('/pair-setup', [[T.State, 3], [T.PublicKey, srp.Abuf], [T.Proof, srp.M1]]);
  console.log('M4 in', Date.now() - t1, 'ms');
  if (!m4[T.Proof].equals(srp.M2)) throw new Error('accessory proof mismatch');
  const me = hc.edKeyPair();
  const myId = Buffer.from(crypto.randomUUID ? crypto.randomUUID().toUpperCase() : crypto.randomBytes(16).toString('hex'));
  const key = hc.hkdf(srp.K, 'Pair-Setup-Encrypt-Salt', 'Pair-Setup-Encrypt-Info');
  const x = hc.hkdf(srp.K, 'Pair-Setup-Controller-Sign-Salt', 'Pair-Setup-Controller-Sign-Info');
  const sig = hc.edSign(me.priv, Buffer.concat([x, myId, me.pub]));
  const enc = hc.seal(key, hc.labelNonce('PS-Msg05'), tlv.encode([[T.Identifier, myId], [T.PublicKey, me.pub], [T.Signature, sig]]));
  const m6 = await s.tlvPost('/pair-setup', [[T.State, 5], [T.EncryptedData, enc]]);
  const sub = tlv.decode(hc.open(key, hc.labelNonce('PS-Msg06'), m6[T.EncryptedData]));
  const accX = hc.hkdf(srp.K, 'Pair-Setup-Accessory-Sign-Salt', 'Pair-Setup-Accessory-Sign-Info');
  const ok = hc.edVerify(sub[T.PublicKey], Buffer.concat([accX, sub[T.Identifier], sub[T.PublicKey]]), sub[T.Signature]);
  if (!ok) throw new Error('accessory signature invalid');
  fs.writeFileSync(pairingFile, JSON.stringify({
    id: myId.toString(), ltsk: me.priv.toString('hex'), ltpk: me.pub.toString('hex'),
    accId: sub[T.Identifier].toString(), accLtpk: sub[T.PublicKey].toString('hex'),
  }, null, 1));
  console.log('paired with accessory', sub[T.Identifier].toString());
  s.socket.end();
}

async function verified() {
  const p = JSON.parse(fs.readFileSync(pairingFile, 'utf8'));
  const s = await connect();
  const kp = hc.xKeyPair();
  const m2 = await s.tlvPost('/pair-verify', [[T.State, 1], [T.PublicKey, kp.pub]]);
  const shared = hc.xShared(kp.priv, m2[T.PublicKey]);
  const key = hc.hkdf(shared, 'Pair-Verify-Encrypt-Salt', 'Pair-Verify-Encrypt-Info');
  const sub = tlv.decode(hc.open(key, hc.labelNonce('PV-Msg02'), m2[T.EncryptedData]));
  const accInfo = Buffer.concat([m2[T.PublicKey], sub[T.Identifier], kp.pub]);
  if (!hc.edVerify(Buffer.from(p.accLtpk, 'hex'), accInfo, sub[T.Signature])) throw new Error('accessory verify signature invalid');
  const myId = Buffer.from(p.id);
  const sig = hc.edSign(Buffer.from(p.ltsk, 'hex'), Buffer.concat([kp.pub, myId, m2[T.PublicKey]]));
  const enc = hc.seal(key, hc.labelNonce('PV-Msg03'), tlv.encode([[T.Identifier, myId], [T.Signature, sig]]));
  await s.tlvPost('/pair-verify', [[T.State, 3], [T.EncryptedData, enc]]);
  s.enc = {
    writeKey: hc.hkdf(shared, 'Control-Salt', 'Control-Write-Encryption-Key'),
    readKey: hc.hkdf(shared, 'Control-Salt', 'Control-Read-Encryption-Key'),
    readCount: 0, writeCount: 0,
  };
  return { s, p };
}

const NAMES = {
  '3E': 'AccessoryInformation', A2: 'ProtocolInformation', D8: 'Television', D9: 'InputSource', 113: 'TelevisionSpeaker',
  14: 'Identify', 20: 'Manufacturer', 21: 'Model', 23: 'Name', 30: 'SerialNumber', 52: 'FirmwareRevision', 37: 'Version',
  B0: 'Active', E7: 'ActiveIdentifier', E3: 'ConfiguredName', E8: 'SleepDiscoveryMode', E1: 'RemoteKey', DF: 'PowerModeSelection',
  E6: 'Identifier', D6: 'IsConfigured', DB: 'InputSourceType', 135: 'CurrentVisibilityState', 134: 'TargetVisibilityState',
  '11A': 'Mute', E9: 'VolumeControlType', EA: 'VolumeSelector',
};

async function main() {
  if (cmd === 'pair') return pair(args[0]);
  const { s, p } = await verified();
  if (cmd === 'accessories') {
    const r = await s.request('GET', '/accessories');
    const d = JSON.parse(r.body.toString());
    for (const a of d.accessories) {
      for (const sv of a.services) {
        console.log('service ' + (NAMES[sv.type] || sv.type) + ' iid=' + sv.iid + (sv.primary ? ' primary' : '') + (sv.linked ? ' linked=' + sv.linked.join(',') : ''));
        for (const c of sv.characteristics) {
          console.log('   ' + a.aid + '.' + c.iid + ' ' + (NAMES[c.type] || c.type) + ' [' + c.perms.join(',') + '] ' + c.format + (c.value !== undefined ? ' = ' + JSON.stringify(c.value) : ''));
        }
      }
    }
  } else if (cmd === 'get') {
    const r = await s.request('GET', '/characteristics?id=' + args.join(','));
    console.log(r.status, r.body.toString());
  } else if (cmd === 'set') {
    const list = args.map((a) => {
      const [id, v] = a.split('=');
      const [aid, iid] = id.split('.').map(Number);
      return { aid, iid, value: isNaN(Number(v)) ? v : Number(v) };
    });
    const t = Date.now();
    const r = await s.request('PUT', '/characteristics', 'application/hap+json', Buffer.from(JSON.stringify({ characteristics: list })));
    console.log(r.status, r.body.toString(), '(' + (Date.now() - t) + ' ms)');
  } else if (cmd === 'watch') {
    const r = await s.request('GET', '/accessories');
    const d = JSON.parse(r.body.toString());
    const ev = [];
    for (const a of d.accessories) for (const sv of a.services) for (const c of sv.characteristics) {
      if (c.perms.indexOf('ev') >= 0) ev.push({ aid: a.aid, iid: c.iid, ev: true });
    }
    const r2 = await s.request('PUT', '/characteristics', 'application/hap+json', Buffer.from(JSON.stringify({ characteristics: ev })));
    console.log('subscribed to', ev.length, 'characteristics:', r2.status);
    s.onEvent = (e) => console.log(new Date().toISOString().slice(11, 19), 'EVENT', JSON.stringify(e.characteristics));
    await new Promise((res) => setTimeout(res, (parseInt(args[0], 10) || 30) * 1000));
  } else if (cmd === 'unpair') {
    await s.tlvPost('/pairings', [[T.State, 1], [T.Method, 4], [T.Identifier, p.id]]);
    fs.unlinkSync(pairingFile);
    console.log('removed pairing', p.id);
  } else if (cmd === 'list') {
    const r = await s.request('POST', '/pairings', 'application/pairing+tlv8', tlv.encode([[T.State, 1], [T.Method, 5]]));
    console.log(tlv.decodeList(r.body).map((g) => (g[T.Identifier] ? g[T.Identifier].toString() + ' perm=' + (g[T.Permissions] && g[T.Permissions][0]) : '')).filter(Boolean));
  }
  s.socket.end();
}

main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
