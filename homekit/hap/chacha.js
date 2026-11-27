'use strict';
// ChaCha20-Poly1305 AEAD (RFC 8439) in plain JavaScript, for TVs whose
// OpenSSL build has no chacha20-poly1305 cipher. Same interface as the native
// path in crypto.js: seal() returns ciphertext followed by the 16-byte tag.

const crypto = require('crypto');

function rotl(v, n) { return ((v << n) | (v >>> (32 - n))) >>> 0; }

function quarter(x, a, b, c, d) {
  x[a] = (x[a] + x[b]) >>> 0; x[d] = rotl(x[d] ^ x[a], 16);
  x[c] = (x[c] + x[d]) >>> 0; x[b] = rotl(x[b] ^ x[c], 12);
  x[a] = (x[a] + x[b]) >>> 0; x[d] = rotl(x[d] ^ x[a], 8);
  x[c] = (x[c] + x[d]) >>> 0; x[b] = rotl(x[b] ^ x[c], 7);
}

// One 64-byte keystream block.
function block(key, counter, nonce, out) {
  const s = new Uint32Array(16);
  s[0] = 0x61707865; s[1] = 0x3320646e; s[2] = 0x79622d32; s[3] = 0x6b206574;
  for (let i = 0; i < 8; i++) s[4 + i] = key.readUInt32LE(i * 4);
  s[12] = counter >>> 0;
  for (let i = 0; i < 3; i++) s[13 + i] = nonce.readUInt32LE(i * 4);
  const x = new Uint32Array(s);
  for (let i = 0; i < 10; i++) {
    quarter(x, 0, 4, 8, 12); quarter(x, 1, 5, 9, 13); quarter(x, 2, 6, 10, 14); quarter(x, 3, 7, 11, 15);
    quarter(x, 0, 5, 10, 15); quarter(x, 1, 6, 11, 12); quarter(x, 2, 7, 8, 13); quarter(x, 3, 4, 9, 14);
  }
  for (let i = 0; i < 16; i++) out.writeUInt32LE((x[i] + s[i]) >>> 0, i * 4);
  return out;
}

function chacha20(key, counter, nonce, input) {
  const out = Buffer.alloc(input.length);
  const ks = Buffer.alloc(64);
  for (let off = 0, n = counter; off < input.length; off += 64, n++) {
    block(key, n, nonce, ks);
    const end = Math.min(64, input.length - off);
    for (let i = 0; i < end; i++) out[off + i] = input[off + i] ^ ks[i];
  }
  return out;
}

const P = (BigInt(1) << BigInt(130)) - BigInt(5);
const MASK128 = (BigInt(1) << BigInt(128)) - BigInt(1);
const CLAMP = BigInt('0x0ffffffc0ffffffc0ffffffc0fffffff');

function leNum(buf) {
  let hex = '';
  for (let i = buf.length - 1; i >= 0; i--) hex += (buf[i] < 16 ? '0' : '') + buf[i].toString(16);
  return BigInt('0x' + (hex || '0'));
}

function poly1305(msg, key) {
  const r = leNum(key.slice(0, 16)) & CLAMP;
  const s = leNum(key.slice(16, 32));
  let acc = BigInt(0);
  for (let off = 0; off < msg.length; off += 16) {
    const chunk = msg.slice(off, off + 16);
    const n = leNum(chunk) + (BigInt(1) << BigInt(8 * chunk.length));
    acc = ((acc + n) * r) % P;
  }
  acc = (acc + s) & MASK128;
  const tag = Buffer.alloc(16);
  for (let i = 0; i < 16; i++) {
    tag[i] = Number(acc & BigInt(0xff));
    acc >>= BigInt(8);
  }
  return tag;
}

function pad16(n) { return Buffer.alloc((16 - (n % 16)) % 16); }

function u64le(n) {
  const b = Buffer.alloc(8);
  b.writeUInt32LE(n >>> 0, 0);
  b.writeUInt32LE(Math.floor(n / 0x100000000), 4);
  return b;
}

function tagFor(key, nonce, aad, ct) {
  const otk = block(key, 0, nonce, Buffer.alloc(64)).slice(0, 32);
  return poly1305(Buffer.concat([aad, pad16(aad.length), ct, pad16(ct.length), u64le(aad.length), u64le(ct.length)]), otk);
}

function seal(key, nonce, plaintext, aad) {
  const a = aad || Buffer.alloc(0);
  const ct = chacha20(key, 1, nonce, plaintext);
  return Buffer.concat([ct, tagFor(key, nonce, a, ct)]);
}

function open(key, nonce, sealed, aad) {
  if (sealed.length < 16) throw new Error('ciphertext too short');
  const a = aad || Buffer.alloc(0);
  const ct = sealed.slice(0, sealed.length - 16);
  const tag = sealed.slice(sealed.length - 16);
  if (!crypto.timingSafeEqual(tagFor(key, nonce, a, ct), tag)) throw new Error('bad tag');
  return chacha20(key, 1, nonce, ct);
}

module.exports = { seal, open, poly1305, chacha20 };
