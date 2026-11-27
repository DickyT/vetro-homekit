'use strict';
// Accessory database: services and characteristics with fixed instance ids,
// cached values, and write handlers. Values are pushed in by the caller
// (update()); reads always answer from the cache so they never wait on the TV.

const EventEmitter = require('events');

const Status = {
  OK: 0,
  InsufficientPrivileges: -70401,
  CommunicationFailure: -70402,
  Busy: -70403,
  ReadOnly: -70404,
  WriteOnly: -70405,
  NotificationNotSupported: -70406,
  OutOfResources: -70407,
  Timeout: -70408,
  ResourceDoesNotExist: -70409,
  InvalidValue: -70410,
};

const INT_FORMATS = { uint8: [0, 255], uint16: [0, 65535], uint32: [0, 4294967295], int: [-2147483648, 2147483647] };

class HapError extends Error {
  constructor(status, message) {
    super(message || String(status));
    this.status = status;
  }
}

class Characteristic {
  constructor(type, opts) {
    this.type = type;
    this.iid = 0;
    this.format = opts.format;
    this.perms = opts.perms;
    this.value = opts.value === undefined ? null : opts.value;
    this.minValue = opts.minValue;
    this.maxValue = opts.maxValue;
    this.minStep = opts.minStep;
    this.validValues = opts.validValues;
    this.maxLen = opts.maxLen;
    this.unit = opts.unit;
    this.onSet = null;
  }

  canRead() { return this.perms.indexOf('pr') >= 0; }
  canWrite() { return this.perms.indexOf('pw') >= 0; }
  canNotify() { return this.perms.indexOf('ev') >= 0; }

  // Registers fn(value, connection) for controller writes. fn may return a
  // promise; a thrown HapError's status is reported to the controller.
  handle(fn) {
    this.onSet = fn;
    return this;
  }

  // Coerces a value from a controller into this characteristic's format.
  normalize(v) {
    if (this.format === 'bool') {
      if (v === true || v === 1 || v === '1' || v === 'true') return true;
      if (v === false || v === 0 || v === '0' || v === 'false') return false;
      throw new HapError(Status.InvalidValue);
    }
    if (INT_FORMATS[this.format]) {
      const n = Number(v);
      const range = INT_FORMATS[this.format];
      if (!Number.isInteger(n) || n < range[0] || n > range[1]) throw new HapError(Status.InvalidValue);
      if (this.minValue !== undefined && n < this.minValue) throw new HapError(Status.InvalidValue);
      if (this.maxValue !== undefined && n > this.maxValue) throw new HapError(Status.InvalidValue);
      if (this.validValues && this.validValues.indexOf(n) < 0) throw new HapError(Status.InvalidValue);
      return n;
    }
    if (this.format === 'float') {
      const n = Number(v);
      if (!isFinite(n)) throw new HapError(Status.InvalidValue);
      return n;
    }
    if (this.format === 'string') {
      const s = String(v);
      if (s.length > (this.maxLen || 64)) throw new HapError(Status.InvalidValue);
      return s;
    }
    return v; // tlv8 / data: base64 strings, passed through
  }

  toJSON(withValue) {
    const out = { type: this.type, iid: this.iid, perms: this.perms, format: this.format };
    if (withValue !== false && this.canRead()) out.value = this.value;
    if (this.minValue !== undefined) out.minValue = this.minValue;
    if (this.maxValue !== undefined) out.maxValue = this.maxValue;
    if (this.minStep !== undefined) out.minStep = this.minStep;
    if (this.validValues) out['valid-values'] = this.validValues;
    if (this.maxLen !== undefined) out.maxLen = this.maxLen;
    if (this.unit) out.unit = this.unit;
    return out;
  }
}

class Service {
  constructor(type, iid, opts) {
    this.type = type;
    this.iid = iid;
    this.primary = !!(opts && opts.primary);
    this.hidden = !!(opts && opts.hidden);
    this.characteristics = [];
    this.linked = [];
  }

  // Adds a characteristic with the next instance id after the service's own.
  add(type, opts) {
    const c = new Characteristic(type, opts);
    c.iid = this.iid + 1 + this.characteristics.length;
    this.characteristics.push(c);
    return c;
  }

  link(service) {
    this.linked.push(service);
    return this;
  }

  toJSON() {
    const out = {
      type: this.type,
      iid: this.iid,
      characteristics: this.characteristics.map((c) => c.toJSON()),
    };
    if (this.primary) out.primary = true;
    if (this.hidden) out.hidden = true;
    if (this.linked.length) out.linked = this.linked.map((s) => s.iid);
    return out;
  }
}

// A write handler returns KEEP to accept the write but keep the accessory's
// own value (for example to refuse a placeholder name).
const KEEP = { keep: true };

class Accessory extends EventEmitter {
  constructor() {
    super();
    this.aid = 1;
    this.services = [];
    this.byIid = new Map();
    // iids whose current value is sent to a controller as soon as it subscribes.
    this.pushOnSubscribe = new Set();
  }

  // Each service gets a caller-chosen base iid so ids stay stable when other
  // services (for example input sources) are added or removed.
  addService(type, iid, opts) {
    const s = new Service(type, iid, opts);
    this.services.push(s);
    return s;
  }

  index() {
    this.byIid.clear();
    for (const s of this.services) {
      if (this.byIid.has(s.iid)) throw new Error('duplicate iid ' + s.iid);
      this.byIid.set(s.iid, s);
      for (const c of s.characteristics) {
        if (this.byIid.has(c.iid)) throw new Error('duplicate iid ' + c.iid);
        this.byIid.set(c.iid, c);
      }
    }
  }

  characteristic(aid, iid) {
    if (aid !== this.aid) return null;
    const c = this.byIid.get(iid);
    return c instanceof Characteristic ? c : null;
  }

  // Sets a cached value and tells subscribed controllers, except `origin`
  // (the connection whose write caused the change).
  update(c, value, origin) {
    if (c.value === value) return;
    c.value = value;
    if (c.canNotify()) this.emit('change', { aid: this.aid, iid: c.iid, value, origin });
  }

  // Sends the current value to every subscribed controller, the writer included.
  notify(c) {
    if (c.canNotify()) this.emit('change', { aid: this.aid, iid: c.iid, value: c.value, origin: null });
  }

  async write(c, raw, connection) {
    if (!c.canWrite()) throw new HapError(Status.ReadOnly);
    const value = c.normalize(raw);
    const r = c.onSet ? await c.onSet(value, connection) : undefined;
    if (r === KEEP) return;
    if (c.canRead()) this.update(c, value, connection);
  }

  toJSON() {
    return [{ aid: this.aid, services: this.services.map((s) => s.toJSON()) }];
  }
}

module.exports = { Accessory, Service, Characteristic, HapError, Status, KEEP };
