'use strict';
// SRP-6a as HAP uses it: the RFC 5054 3072-bit group, generator 5, SHA-512.
// The group prime is the same as RFC 3526 group 15, which Node ships as 'modp15'.

const crypto = require('crypto');

const N_BUF = crypto.getDiffieHellman('modp15').getPrime();
const N = toNum(N_BUF);
const NLEN = N_BUF.length; // 384
const g = BigInt(5);
const ZERO = BigInt(0);
const ONE = BigInt(1);

function toNum(b) {
  return BigInt('0x' + (b.length ? b.toString('hex') : '0'));
}

function toBuf(n, len) {
  let h = n.toString(16);
  if (h.length % 2) h = '0' + h;
  const b = Buffer.from(h, 'hex');
  if (len && b.length < len) return Buffer.concat([Buffer.alloc(len - b.length), b]);
  return b;
}

function H() {
  const h = crypto.createHash('sha512');
  for (let i = 0; i < arguments.length; i++) h.update(arguments[i]);
  return h.digest();
}

function modPow(base, exp, mod) {
  let r = ONE;
  let b = base % mod;
  let e = exp;
  while (e > ZERO) {
    if (e & ONE) r = (r * b) % mod;
    e >>= ONE;
    b = (b * b) % mod;
  }
  return r;
}

const k = toNum(H(N_BUF, toBuf(g, NLEN)));

function xorHashes() {
  const hN = H(N_BUF);
  const hg = H(toBuf(g));
  const out = Buffer.alloc(hN.length);
  for (let i = 0; i < hN.length; i++) out[i] = hN[i] ^ hg[i];
  return out;
}
const HNxorHg = xorHashes();

// M1 = H(H(N) xor H(g) | H(I) | s | A | B | K)
function clientProof(I, salt, Abuf, Bbuf, K) {
  return H(HNxorHg, H(Buffer.from(I)), salt, Abuf, Bbuf, K);
}

class SrpServer {
  constructor(username, password, salt) {
    this.I = username;
    this.salt = salt || crypto.randomBytes(16);
    const x = toNum(H(this.salt, H(Buffer.from(username + ':' + password))));
    this.v = modPow(g, x, N);
    // Pick b so that B fills all 384 bytes; that way the padded and unpadded
    // encodings of B are the same and no implementation detail can differ.
    for (;;) {
      this.b = toNum(crypto.randomBytes(32));
      this.B = (k * this.v + modPow(g, this.b, N)) % N;
      this.Bbuf = toBuf(this.B);
      if (this.Bbuf.length === NLEN) break;
    }
  }

  // Returns { K, M2 } when the controller's proof is right, otherwise null.
  verify(Abuf, M1) {
    const A = toNum(Abuf);
    if (A % N === ZERO) return null;
    const u = toNum(H(toBuf(A, NLEN), this.Bbuf));
    if (u === ZERO) return null;
    const S = modPow((A * modPow(this.v, u, N)) % N, this.b, N);
    const K = H(toBuf(S, NLEN));
    const expected = clientProof(this.I, this.salt, Abuf, this.Bbuf, K);
    if (M1.length !== expected.length || !crypto.timingSafeEqual(expected, M1)) return null;
    return { K, M2: H(Abuf, M1, K) };
  }
}

// Client side, used only by the test controller.
class SrpClient {
  constructor(username, password, salt, Bbuf) {
    this.I = username;
    this.salt = salt;
    const x = toNum(H(salt, H(Buffer.from(username + ':' + password))));
    const B = toNum(Bbuf);
    let a;
    let A;
    for (;;) {
      a = toNum(crypto.randomBytes(32));
      A = modPow(g, a, N);
      if (toBuf(A).length === NLEN) break;
    }
    this.Abuf = toBuf(A, NLEN);
    const u = toNum(H(this.Abuf, toBuf(B, NLEN)));
    const base = ((B - ((k * modPow(g, x, N)) % N)) % N + N) % N;
    const S = modPow(base, a + u * x, N);
    this.K = H(toBuf(S, NLEN));
    this.M1 = clientProof(username, salt, this.Abuf, Bbuf, this.K);
    this.M2 = H(this.Abuf, this.M1, this.K);
  }
}

module.exports = { SrpServer, SrpClient };
