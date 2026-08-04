/**
 * Atomic JSON state store.
 *
 * Persists gateway resume state and thread -> Copilot session mappings only.
 * Never persists prompt/message content or pending approval tokens/nonces.
 *
 * Writes are atomic: write to a temp file in the same directory, fsync, then
 * rename over the target. The state directory is created with mode 0700 and
 * the state file with mode 0600.
 *
 * Corrupt state is never silently discarded: the bad file is quarantined
 * (renamed aside) and a StateCorruptError is thrown so the operator notices.
 */
import { randomBytes } from 'node:crypto';
import { mkdir, open, rename, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const STATE_VERSION = 1;

export class StateCorruptError extends Error {
  constructor(message, quarantinePath) {
    super(message);
    this.name = 'StateCorruptError';
    this.quarantinePath = quarantinePath;
  }
}

/** @returns {object} an empty, valid state document */
function emptyState() {
  return { version: STATE_VERSION, gateway: null, threads: {} };
}

// Discord snowflake IDs are 17-20 digit decimal strings.
const SNOWFLAKE_RE = /^[0-9]{17,20}$/;

/** @param {unknown} v @returns {v is string} */
function isNonEmptyString(v) {
  return typeof v === 'string' && v.length > 0;
}

/** @param {unknown} v @returns {boolean} true if v is a valid ISO-8601 timestamp string */
function isIsoTimestamp(v) {
  return typeof v === 'string' && v.length > 0 && !Number.isNaN(Date.parse(v));
}

/** @param {unknown} v @returns {boolean} true if v is an absolute filesystem path */
function isAbsolutePath(v) {
  return typeof v === 'string' && path.isAbsolute(v);
}

/**
 * Validates the persisted gateway resume-state shape: exactly the keys
 * sessionId (string|null), seq (number|null), resumeGatewayUrl (string|null).
 * `null` (never connected/no resume state yet) is also valid.
 * @param {unknown} gateway
 * @returns {boolean}
 */
function isValidGatewayShape(gateway) {
  if (gateway === null) return true;
  if (!gateway || typeof gateway !== 'object' || Array.isArray(gateway)) return false;
  const keys = Object.keys(gateway);
  if (keys.length !== 3) return false;
  const g = /** @type {any} */ (gateway);
  if (!('sessionId' in g) || !('seq' in g) || !('resumeGatewayUrl' in g)) return false;
  if (g.sessionId !== null && typeof g.sessionId !== 'string') return false;
  if (g.seq !== null && typeof g.seq !== 'number') return false;
  if (g.resumeGatewayUrl !== null && typeof g.resumeGatewayUrl !== 'string') return false;
  return true;
}

/**
 * Validates a single persisted thread record: exactly the keys
 * copilotSessionId (string|null), cwd (absolute path string),
 * createdAt/updatedAt (ISO timestamp strings).
 * @param {unknown} thread
 * @returns {boolean}
 */
function isValidThreadShape(thread) {
  if (!thread || typeof thread !== 'object' || Array.isArray(thread)) return false;
  const keys = Object.keys(thread);
  if (keys.length !== 4) return false;
  const t = /** @type {any} */ (thread);
  if (!('copilotSessionId' in t) || !('cwd' in t) || !('createdAt' in t) || !('updatedAt' in t)) return false;
  if (t.copilotSessionId !== null && !isNonEmptyString(t.copilotSessionId)) return false;
  if (!isAbsolutePath(t.cwd)) return false;
  if (!isIsoTimestamp(t.createdAt)) return false;
  if (!isIsoTimestamp(t.updatedAt)) return false;
  return true;
}

/**
 * Validates the top-level persisted document shape: the version must match
 * exactly what this build writes, `gateway` and every entry of `threads`
 * must match their exact expected field sets/types (no arbitrary/extra
 * fields accepted), and every thread key must be a Discord snowflake ID.
 * @param {unknown} doc
 * @returns {doc is {version:number, gateway:unknown, threads:Record<string,unknown>}}
 */
function isValidShape(doc) {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return false;
  const d = /** @type {any} */ (doc);
  if (d.version !== STATE_VERSION) return false;
  if (!('gateway' in d) || !isValidGatewayShape(d.gateway)) return false;
  if (typeof d.threads !== 'object' || d.threads === null || Array.isArray(d.threads)) return false;
  for (const [threadId, thread] of Object.entries(d.threads)) {
    if (!SNOWFLAKE_RE.test(threadId)) return false;
    if (!isValidThreadShape(thread)) return false;
  }
  return true;
}

export class StateStore {
  /**
   * @param {string} stateDir
   * @param {import('./logger.js').Logger} [logger]
   * @param {{mkdir?:Function, open?:Function, rename?:Function, readFile?:Function}} [deps] injectable fs
   *   implementations, used only by tests to deterministically exercise concurrent-save ordering.
   */
  constructor(stateDir, logger, deps = {}) {
    this.stateDir = stateDir;
    this.filePath = path.join(stateDir, 'state.json');
    this.logger = logger;
    this._fs = { mkdir, open, rename, readFile, ...deps };
    /** @type {{version:number, gateway:unknown, threads:Record<string,object>}} */
    this.data = emptyState();
    // Serializes save() calls so concurrent writers can never have an older
    // (earlier-called) save's rename land after a newer save's rename.
    this._saveChain = Promise.resolve();
  }

  /** Ensures the state directory exists with 0700 permissions. */
  async _ensureDir() {
    await this._fs.mkdir(this.stateDir, { recursive: true, mode: 0o700 });
  }

  /**
   * Loads state from disk. If no file exists, initializes empty state.
   * If the file exists but is corrupt/invalid, quarantines it and throws.
   */
  async load() {
    await this._ensureDir();
    let raw;
    try {
      raw = await this._fs.readFile(this.filePath, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') {
        this.data = emptyState();
        return this.data;
      }
      throw err;
    }

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      const quarantinePath = `${this.filePath}.corrupt-${Date.now()}`;
      await this._fs.rename(this.filePath, quarantinePath);
      throw new StateCorruptError(
        `State file is corrupt JSON and has been quarantined to ${quarantinePath}: ${err.message}`,
        quarantinePath,
      );
    }

    if (!isValidShape(parsed)) {
      const quarantinePath = `${this.filePath}.corrupt-${Date.now()}`;
      await this._fs.rename(this.filePath, quarantinePath);
      throw new StateCorruptError(
        `State file has an invalid shape and has been quarantined to ${quarantinePath}`,
        quarantinePath,
      );
    }

    this.data = { version: STATE_VERSION, gateway: parsed.gateway ?? null, threads: parsed.threads };
    return this.data;
  }

  /**
   * Atomically persists the current in-memory state to disk. Concurrent
   * calls are serialized (queued in call order): a snapshot of `this.data`
   * is taken synchronously at call time, and the actual write/rename for
   * that snapshot only runs once every previously-queued save has settled.
   * This guarantees an older save's rename can never clobber a newer one.
   */
  save() {
    const snapshot = JSON.parse(JSON.stringify(this.data));
    const previous = this._saveChain;
    const runThisSave = previous.catch(() => {}).then(() => this._writeSnapshot(snapshot));
    // Keep the shared chain alive even if this write fails, so later saves
    // still get their turn; the caller of *this* save() still observes the
    // real outcome via the returned promise.
    this._saveChain = runThisSave.catch(() => {});
    return runThisSave;
  }

  /** @private @param {object} snapshot */
  async _writeSnapshot(snapshot) {
    await this._ensureDir();
    const tmpPath = path.join(this.stateDir, `.state.json.tmp-${randomBytes(6).toString('hex')}`);
    const json = JSON.stringify(snapshot, null, 2);
    const handle = await this._fs.open(tmpPath, 'w', 0o600);
    try {
      await handle.writeFile(json, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await this._fs.rename(tmpPath, this.filePath);
  }

  /** @returns {object|null} */
  getGateway() {
    return this.data.gateway;
  }

  /** @param {object|null} gateway */
  setGateway(gateway) {
    this.data.gateway = gateway;
  }

  /** @param {string} threadId @returns {object|undefined} */
  getThread(threadId) {
    return this.data.threads[threadId];
  }

  /** @param {string} threadId @param {object} thread */
  setThread(threadId, thread) {
    this.data.threads[threadId] = thread;
  }

  /** @param {string} threadId */
  deleteThread(threadId) {
    delete this.data.threads[threadId];
  }

  /** @returns {Record<string, object>} */
  listThreads() {
    return this.data.threads;
  }
}

/** Direct (non-class) helper used by tests that want a one-off write. */
export async function writeStateFileForTest(filePath, data) {
  await writeFile(filePath, JSON.stringify(data, null, 2), { mode: 0o600 });
}
