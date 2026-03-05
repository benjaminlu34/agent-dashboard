import { EventEmitter } from "node:events";

function ensureString(value) {
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  return String(value);
}

function cloneObject(obj) {
  return Object.fromEntries(Object.entries(obj ?? {}).map(([key, value]) => [key, ensureString(value)]));
}

export class FakeRedis {
  constructor() {
    this._hashes = new Map();
    this._lists = new Map();
  }

  _getHash(key) {
    const normalizedKey = ensureString(key);
    let hash = this._hashes.get(normalizedKey);
    if (!hash) {
      hash = new Map();
      this._hashes.set(normalizedKey, hash);
    }
    return hash;
  }

  _getList(key) {
    const normalizedKey = ensureString(key);
    let list = this._lists.get(normalizedKey);
    if (!list) {
      list = [];
      this._lists.set(normalizedKey, list);
    }
    return list;
  }

  async hgetall(key) {
    const hash = this._hashes.get(ensureString(key));
    if (!hash) {
      return {};
    }
    return Object.fromEntries(Array.from(hash.entries()));
  }

  async hget(key, field) {
    const hash = this._hashes.get(ensureString(key));
    if (!hash) {
      return null;
    }
    const value = hash.get(ensureString(field));
    return value === undefined ? null : value;
  }

  async hset(key, ...args) {
    const hash = this._getHash(key);

    if (args.length === 1 && args[0] && typeof args[0] === "object" && !Array.isArray(args[0])) {
      const mapping = cloneObject(args[0]);
      for (const [field, value] of Object.entries(mapping)) {
        hash.set(field, value);
      }
      return Object.keys(mapping).length;
    }

    if (args.length === 2) {
      const field = ensureString(args[0]);
      const value = ensureString(args[1]);
      hash.set(field, value);
      return 1;
    }

    throw new Error(`FakeRedis.hset unsupported arguments: ${args.length}`);
  }

  async hdel(key, ...fields) {
    const hash = this._hashes.get(ensureString(key));
    if (!hash) {
      return 0;
    }
    let removed = 0;
    for (const field of fields) {
      if (hash.delete(ensureString(field))) {
        removed += 1;
      }
    }
    return removed;
  }

  async del(key) {
    const normalized = ensureString(key);
    const hadHash = this._hashes.delete(normalized);
    const hadList = this._lists.delete(normalized);
    return hadHash || hadList ? 1 : 0;
  }

  async lpush(key, value) {
    const list = this._getList(key);
    list.unshift(ensureString(value));
    return list.length;
  }

  async rpush(key, value) {
    const list = this._getList(key);
    list.push(ensureString(value));
    return list.length;
  }

  async lpop(key) {
    const list = this._lists.get(ensureString(key));
    if (!list || list.length === 0) {
      return null;
    }
    return list.shift() ?? null;
  }

  pipeline() {
    return new FakeRedisPipeline(this);
  }

  _snapshotList(key) {
    return this._getList(key).slice();
  }
}

class FakeRedisPipeline {
  constructor(redis) {
    this._redis = redis;
    this._ops = [];
  }

  hset(key, ...args) {
    this._ops.push(async () => this._redis.hset(key, ...args));
    return this;
  }

  hdel(key, ...fields) {
    this._ops.push(async () => this._redis.hdel(key, ...fields));
    return this;
  }

  del(key) {
    this._ops.push(async () => this._redis.del(key));
    return this;
  }

  async exec() {
    const results = [];
    for (const op of this._ops) {
      try {
        // ioredis pipeline returns [err, result] tuples.
        // Use null for err to emulate success.
        // eslint-disable-next-line no-await-in-loop
        const result = await op();
        results.push([null, result]);
      } catch (error) {
        results.push([error, null]);
      }
    }
    return results;
  }
}

export class FakeRedisSub extends EventEmitter {
  constructor() {
    super();
    this._patterns = new Set();
  }

  async psubscribe(pattern) {
    this._patterns.add(ensureString(pattern));
    return 1;
  }

  emitPMessage({ pattern = "telemetry:events:*", channel, message }) {
    this.emit("pmessage", pattern, ensureString(channel), ensureString(message));
  }
}

