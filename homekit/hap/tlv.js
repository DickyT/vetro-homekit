'use strict';
// TLV8 as used by HAP pairing. A value longer than 255 bytes is split into
// consecutive items of the same type, and decode() joins them back.

const T = {
  Method: 0x00, Identifier: 0x01, Salt: 0x02, PublicKey: 0x03, Proof: 0x04,
  EncryptedData: 0x05, State: 0x06, Error: 0x07, RetryDelay: 0x08,
  Certificate: 0x09, Signature: 0x0a, Permissions: 0x0b, FragmentData: 0x0c,
  FragmentLast: 0x0d, Flags: 0x13, Separator: 0xff,
};

const E = {
  Unknown: 1, Authentication: 2, Backoff: 3, MaxPeers: 4, MaxTries: 5,
  Unavailable: 6, Busy: 7,
};

function toBuffer(v) {
  if (Buffer.isBuffer(v)) return v;
  if (typeof v === 'number') return Buffer.from([v]);
  return Buffer.from(String(v), 'utf8');
}

// items: array of [type, value]; value is a Buffer, a one-byte number or a string.
function encode(items) {
  const parts = [];
  for (const [type, raw] of items) {
    const v = toBuffer(raw);
    if (v.length === 0) {
      parts.push(Buffer.from([type, 0]));
      continue;
    }
    for (let off = 0; off < v.length; off += 255) {
      const chunk = v.slice(off, off + 255);
      parts.push(Buffer.from([type, chunk.length]), chunk);
    }
  }
  return Buffer.concat(parts);
}

// Returns an object keyed by type. Use decodeList() when a type repeats
// (separated items, as in a list-pairings response).
function decode(buf) {
  const out = {};
  let i = 0;
  let last = -1;
  while (i + 2 <= buf.length) {
    const type = buf[i];
    const len = buf[i + 1];
    const v = buf.slice(i + 2, i + 2 + len);
    i += 2 + len;
    if (type === last && out[type]) out[type] = Buffer.concat([out[type], v]);
    else out[type] = v;
    last = type;
  }
  return out;
}

// Splits on Separator items and decodes each group.
function decodeList(buf) {
  const groups = [];
  let cur = [];
  let i = 0;
  while (i + 2 <= buf.length) {
    const type = buf[i];
    const len = buf[i + 1];
    if (type === T.Separator) {
      groups.push(Buffer.concat(cur));
      cur = [];
    } else {
      cur.push(buf.slice(i, i + 2 + len));
    }
    i += 2 + len;
  }
  groups.push(Buffer.concat(cur));
  return groups.map(decode);
}

module.exports = { T, E, encode, decode, decodeList };
