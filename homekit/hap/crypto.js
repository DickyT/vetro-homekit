'use strict';
// Crypto primitives HAP needs, on top of Node's built-in crypto:
// HKDF-SHA512, ChaCha20-Poly1305, Ed25519 and X25519 with raw 32-byte keys.

const crypto = require('crypto');

// DER prefixes that turn a raw 32-byte key into SPKI / PKCS#8.
const ED_SPKI = Buffer.from('302a300506032b6570032100', 'hex');
const ED_PKCS8 = Buffer.from('302e020100300506032b657004220420', 'hex');
const X_SPKI = Buffer.from('302a300506032b656e032100', 'hex');
const X_PKCS8 = Buffer.from('302e020100300506032b656e04220420', 'hex');

// Some TV OpenSSL builds have no chacha20-poly1305; fall back to plain JS then.
const NATIVE_CHACHA = !process.env.HK_FORCE_JS_CHACHA && crypto.getCiphers().indexOf('chacha20-poly1305') >= 0;
const jsChacha = NATIVE_CHACHA ? null : require('./chacha');

function missingFeatures() {
  const missing = [];
  if (typeof BigInt !== 'function') missing.push('BigInt');
  if (typeof crypto.generateKeyPairSync !== 'function' || typeof crypto.sign !== 'function') missing.push('ed25519');
  if (typeof crypto.diffieHellman !== 'function') missing.push('x25519');
  return missing;
}

function hkdf(ikm, salt, info, len) {
  const size = len || 32;
  const prk = crypto.createHmac('sha512', Buffer.from(salt)).update(ikm).digest();
  let t = Buffer.alloc(0);
  let okm = Buffer.alloc(0);
  for (let i = 1; okm.length < size; i++) {
    t = crypto.createHmac('sha512', prk)
      .update(Buffer.concat([t, Buffer.from(info), Buffer.from([i])]))
      .digest();
    okm = Buffer.concat([okm, t]);
  }
  return okm.slice(0, size);
}

// 12-byte nonce: 4 zero bytes then an 8-byte label such as "PS-Msg05".
function labelNonce(label) {
  return Buffer.concat([Buffer.alloc(4), Buffer.from(label, 'ascii')]);
}

// 12-byte nonce: 4 zero bytes then a 64-bit little-endian counter.
function counterNonce(n) {
  const b = Buffer.alloc(12);
  b.writeUInt32LE(n >>> 0, 4);
  b.writeUInt32LE(Math.floor(n / 0x100000000), 8);
  return b;
}

// Returns ciphertext followed by the 16-byte tag.
function seal(key, nonce, plaintext, aad) {
  if (jsChacha) return jsChacha.seal(key, nonce, plaintext, aad);
  const c = crypto.createCipheriv('chacha20-poly1305', key, nonce, { authTagLength: 16 });
  if (aad) c.setAAD(aad, { plaintextLength: plaintext.length });
  const ct = Buffer.concat([c.update(plaintext), c.final()]);
  return Buffer.concat([ct, c.getAuthTag()]);
}

// Throws if the tag does not verify.
function open(key, nonce, sealed, aad) {
  if (jsChacha) return jsChacha.open(key, nonce, sealed, aad);
  if (sealed.length < 16) throw new Error('ciphertext too short');
  const body = sealed.slice(0, sealed.length - 16);
  const d = crypto.createDecipheriv('chacha20-poly1305', key, nonce, { authTagLength: 16 });
  if (aad) d.setAAD(aad, { plaintextLength: body.length });
  d.setAuthTag(sealed.slice(sealed.length - 16));
  return Buffer.concat([d.update(body), d.final()]);
}

function rawKeyPair(kind) {
  const pair = crypto.generateKeyPairSync(kind);
  return {
    pub: pair.publicKey.export({ type: 'spki', format: 'der' }).slice(-32),
    priv: pair.privateKey.export({ type: 'pkcs8', format: 'der' }).slice(-32),
  };
}

function edKeyPair() { return rawKeyPair('ed25519'); }
function xKeyPair() { return rawKeyPair('x25519'); }

function edSign(priv, msg) {
  const key = crypto.createPrivateKey({ key: Buffer.concat([ED_PKCS8, priv]), format: 'der', type: 'pkcs8' });
  return crypto.sign(null, msg, key);
}

function edVerify(pub, msg, sig) {
  try {
    const key = crypto.createPublicKey({ key: Buffer.concat([ED_SPKI, pub]), format: 'der', type: 'spki' });
    return crypto.verify(null, msg, key, sig);
  } catch (e) {
    return false;
  }
}

function xShared(priv, peerPub) {
  return crypto.diffieHellman({
    privateKey: crypto.createPrivateKey({ key: Buffer.concat([X_PKCS8, priv]), format: 'der', type: 'pkcs8' }),
    publicKey: crypto.createPublicKey({ key: Buffer.concat([X_SPKI, peerPub]), format: 'der', type: 'spki' }),
  });
}

module.exports = {
  nativeChacha: NATIVE_CHACHA, missingFeatures, hkdf, labelNonce, counterNonce, seal, open,
  edKeyPair, xKeyPair, edSign, edVerify, xShared,
};
