'use strict';
// Checks the plain-JS ChaCha20-Poly1305 against the RFC 8439 test vector and
// against Node's native cipher on random inputs.
const crypto = require('crypto');
const js = require('../homekit/hap/chacha');
const assert = require('assert');

const key = Buffer.from('808182838485868788898a8b8c8d8e8f909192939495969798999a9b9c9d9e9f', 'hex');
const nonce = Buffer.from('070000004041424344454647', 'hex');
const aad = Buffer.from('50515253c0c1c2c3c4c5c6c7', 'hex');
const pt = Buffer.from("Ladies and Gentlemen of the class of '99: If I could offer you only one tip for the future, sunscreen would be it.");
const sealed = js.seal(key, nonce, pt, aad);
assert.strictEqual(sealed.slice(-16).toString('hex'), '1ae10b594f09e26a7e902ecbd0600691', 'RFC 8439 tag');
assert.ok(js.open(key, nonce, sealed, aad).equals(pt), 'RFC 8439 round trip');
console.log('RFC 8439 vector ok');

function native(k, n, p, a) {
  const c = crypto.createCipheriv('chacha20-poly1305', k, n, { authTagLength: 16 });
  c.setAAD(a, { plaintextLength: p.length });
  return Buffer.concat([c.update(p), c.final(), c.getAuthTag()]);
}

for (let i = 0; i < 300; i++) {
  const k = crypto.randomBytes(32);
  const n = crypto.randomBytes(12);
  const p = crypto.randomBytes(Math.floor(Math.random() * 3000));
  const a = crypto.randomBytes(Math.floor(Math.random() * 20));
  const s = js.seal(k, n, p, a);
  assert.ok(s.equals(native(k, n, p, a)), 'matches native, len ' + p.length);
  assert.ok(js.open(k, n, s, a).equals(p));
  const bad = Buffer.from(s);
  bad[Math.floor(Math.random() * bad.length)] ^= 1;
  assert.throws(() => js.open(k, n, bad, a), 'tampered data must fail');
}
console.log('300 random cases match native; tampering detected');

const big = crypto.randomBytes(1024);
const t = process.hrtime.bigint();
for (let i = 0; i < 200; i++) js.seal(key, nonce, big, aad.slice(0, 2));
console.log('JS seal of a 1024-byte frame:', Number(process.hrtime.bigint() - t) / 200 / 1e6, 'ms');
