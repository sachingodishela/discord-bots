/**
 * ACP (Agent Client Protocol) stdio JSON-RPC client.
 *
 * Spawns `copilot --acp --stdio` as a child process per Discord thread.
 * Communicates via newline-delimited JSON-RPC 2.0 on stdin/stdout. stdout is
 * protocol-only; any human-readable logging goes to stderr on the child
 * side, of which we retain only a bounded tail (with best-effort secret
 * redaction) for diagnostics - never persisted, never logged unless there is
 * an actual error.
 */
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { encodeNdjson, NdjsonDecoder } from './ndjson.js';

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const STDERR_TAIL_MAX_BYTES = 4096;
const PROTOCOL_VERSION = 1;

export class AcpChildExitError extends Error {
  constructor(code, signal) {
    super(`ACP child process exited (code=${code}, signal=${signal})`);
    this.name = 'AcpChildExitError';
    this.code = code;
    this.signal = signal;
  }
}

export class AcpTimeoutError extends Error {
  constructor(method) {
    super(`ACP request timed out: ${method}`);
    this.name = 'AcpTimeoutError';
  }
}

export class AcpProtocolError extends Error {
  /** @param {string} message @param {{code?: number, data?: any}} [rpcError] */
  constructor(message, rpcError) {
    super(message);
    this.name = 'AcpProtocolError';
    this.code = rpcError?.code;
    this.data = rpcError?.data;
  }
}

/** Thrown when the agent's protocolVersion doesn't match what we speak. */
export class AcpProtocolVersionError extends Error {
  /** @param {any} expected @param {any} actual */
  constructor(expected, actual) {
    super(`ACP protocolVersion mismatch: expected ${expected}, agent reported ${actual}`);
    this.name = 'AcpProtocolVersionError';
    this.expected = expected;
    this.actual = actual;
  }
}

/**
 * Thrown when the broker attempts an operation (session resume/load) that
 * the agent did not advertise support for in its `initialize` response.
 */
export class AcpUnsupportedError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AcpUnsupportedError';
  }
}

/** Thrown when the child process itself fails to spawn or emits an I/O error. */
export class AcpSpawnError extends Error {
  /** @param {Error} cause */
  constructor(cause) {
    super(`ACP child process failed to spawn or errored: ${cause?.message || cause}`);
    this.name = 'AcpSpawnError';
    this.cause = cause;
  }
}

const SECRET_PATTERNS = [
  /gh[pousr]_[A-Za-z0-9]{20,}/g,
  /Bearer\s+[\w.\-]+/gi,
];

/** @param {string} text */
function redact(text) {
  let out = text;
  for (const re of SECRET_PATTERNS) out = out.replace(re, '[REDACTED]');
  return out;
}

/**
 * Emits: 'update' (sessionId, update), 'permission-request' (request, respond),
 * 'exit' (code, signal), 'error' (err)
 */
export class AcpClient extends EventEmitter {
  /**
   * @param {{copilotBin:string, cwd:string, allowAll?:boolean, logger:import('../logger.js').Logger, spawnImpl?: typeof spawn}} opts
   */
  constructor(opts) {
    super();
    this._copilotBin = opts.copilotBin;
    this._cwd = opts.cwd;
    this._allowAll = opts.allowAll === true;
    this.logger = opts.logger.child({ component: 'acp-client' });
    this._spawnImpl = opts.spawnImpl || spawn;
    this._child = null;
    this._decoder = new NdjsonDecoder();
    this._nextId = 1;
    /** @type {Map<number, {resolve:Function, reject:Function, timer:NodeJS.Timeout|null, method:string}>} */
    this._pending = new Map();
    this._stderrTail = '';
    this._exited = false;
    /** @type {Error|null} the terminal error (exit/spawn failure), reused for any calls made after. */
    this._terminalError = null;
    this._serverCapabilities = null;
  }

  /** Spawns the child process and wires up stdio handling. */
  start() {
    const args = this._allowAll
      ? ['--allow-all', '--acp', '--stdio']
      : ['--acp', '--stdio'];
    const child = this._spawnImpl(this._copilotBin, args, {
      cwd: this._cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
    });
    this._child = child;

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => this._onStdout(chunk));

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      this._stderrTail = redact((this._stderrTail + chunk).slice(-STDERR_TAIL_MAX_BYTES));
    });

    child.on('exit', (code, signal) => {
      if (this._exited) return; // already handled via a spawn/IO 'error' event
      this._exited = true;
      const err = new AcpChildExitError(code, signal);
      this._terminalError = err;
      for (const [, pending] of this._pending) {
        if (pending.timer) clearTimeout(pending.timer);
        pending.reject(err);
      }
      this._pending.clear();
      this.emit('exit', code, signal, this._stderrTail);
    });

    child.on('error', (err) => {
      this.logger.error('child process spawn/IO error', { error: err.message });
      if (this._exited) return; // an 'exit' event already handled this
      this._exited = true;
      const spawnErr = new AcpSpawnError(err);
      this._terminalError = spawnErr;
      for (const [, pending] of this._pending) {
        if (pending.timer) clearTimeout(pending.timer);
        pending.reject(spawnErr);
      }
      this._pending.clear();
      // Node's EventEmitter throws synchronously if an 'error' event has no
      // listeners; guard against that so a spawn failure can never crash
      // the process. Callers that care can still listen for 'error'.
      if (this.listenerCount('error') > 0) {
        this.emit('error', err);
      }
    });

    return this;
  }

  /** @returns {string} bounded, best-effort-redacted stderr tail */
  getStderrTail() {
    return this._stderrTail;
  }

  /** @private @param {string} chunk */
  _onStdout(chunk) {
    const { objects, errors } = this._decoder.push(chunk);
    for (const err of errors) {
      this.logger.warn('ndjson decode error', { error: err.message });
    }
    for (const obj of objects) {
      this._handleMessage(obj);
    }
  }

  /** @private @param {any} msg */
  _handleMessage(msg) {
    if (msg && typeof msg === 'object' && 'id' in msg && ('result' in msg || 'error' in msg)) {
      const pending = this._pending.get(msg.id);
      if (!pending) return;
      this._pending.delete(msg.id);
      if (pending.timer) clearTimeout(pending.timer);
      if (msg.error) {
        pending.reject(new AcpProtocolError(msg.error.message || 'ACP error', msg.error));
      } else {
        pending.resolve(msg.result);
      }
      return;
    }

    if (msg && typeof msg === 'object' && 'method' in msg && 'id' in msg) {
      // Reverse request from the agent (e.g. session/request_permission).
      this._handleReverseRequest(msg);
      return;
    }

    if (msg && typeof msg === 'object' && 'method' in msg) {
      // Notification (no id): e.g. session/update.
      this.emit('notification', msg.method, msg.params);
      return;
    }
  }

  /** @private @param {{id:number|string, method:string, params:any}} msg */
  _handleReverseRequest(msg) {
    const respond = (result) => {
      this._write({ jsonrpc: '2.0', id: msg.id, result });
    };
    const respondError = (code, message) => {
      this._write({ jsonrpc: '2.0', id: msg.id, error: { code, message } });
    };
    this.emit('reverse-request', msg.method, msg.params, respond, respondError);
  }

  /** @private @param {object} obj */
  _write(obj) {
    if (!this._child || this._exited) return;
    this._child.stdin.write(encodeNdjson(obj));
  }

  /**
   * Sends a JSON-RPC request and waits for a matched response.
   * @param {string} method
   * @param {object} params
   * @param {{timeoutMs?: number|null}} [opts] pass timeoutMs: null to disable timeout (long prompts)
   * @returns {Promise<any>}
   */
  call(method, params, opts = {}) {
    if (this._exited) return Promise.reject(this._terminalError || new AcpChildExitError(null, null));
    const id = this._nextId++;
    const timeoutMs = opts.timeoutMs === undefined ? DEFAULT_REQUEST_TIMEOUT_MS : opts.timeoutMs;
    return new Promise((resolve, reject) => {
      let timer = null;
      if (timeoutMs !== null) {
        timer = setTimeout(() => {
          this._pending.delete(id);
          reject(new AcpTimeoutError(method));
        }, timeoutMs);
      }
      this._pending.set(id, { resolve, reject, timer, method });
      this._write({ jsonrpc: '2.0', id, method, params });
    });
  }

  /** Sends a JSON-RPC notification (no response expected). @param {string} method @param {object} params */
  notify(method, params) {
    this._write({ jsonrpc: '2.0', method, params });
  }

  /**
   * ACP initialize handshake. Advertises only capabilities we actually
   * implement: we don't implement `fs` or `terminal` client capabilities at
   * all, so those keys are omitted entirely rather than being advertised
   * with `false` values (which would still declare the capability shape as
   * "known but unsupported" instead of "not implemented by this client").
   * Validates that the agent speaks the protocol version we expect.
   */
  async initialize() {
    const result = await this.call('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      clientInfo: { name: 'discord-copilot-broker', version: '1.0.0' },
      clientCapabilities: {},
    });
    if (result?.protocolVersion !== PROTOCOL_VERSION) {
      throw new AcpProtocolVersionError(PROTOCOL_VERSION, result?.protocolVersion);
    }
    this._serverCapabilities = result?.agentCapabilities || {};
    return result;
  }

  /** @param {string} cwd @returns {Promise<string>} sessionId */
  async sessionNew(cwd) {
    const result = await this.call('session/new', { cwd, mcpServers: [] });
    return result.sessionId;
  }

  /**
   * Attempts session/resume, falling back to session/load if resume isn't
   * supported by the agent - but only ever calling whichever method(s) the
   * agent actually advertised in its `initialize` response
   * (`agentCapabilities.sessionCapabilities.resume` /
   * `agentCapabilities.loadSession`). If neither is advertised, fails clearly
   * instead of guessing.
   * @param {string} sessionId @param {string} cwd
   * @returns {Promise<{method:'resume'|'load', result:any}>}
   */
  async sessionResume(sessionId, cwd) {
    const caps = this._serverCapabilities || {};
    const supportsResume = !!caps.sessionCapabilities?.resume;
    const supportsLoad = !!caps.loadSession;

    if (!supportsResume && !supportsLoad) {
      throw new AcpUnsupportedError(
        'Agent does not advertise session resume or load capability (agentCapabilities.sessionCapabilities.resume / agentCapabilities.loadSession)',
      );
    }

    if (supportsResume) {
      try {
        const result = await this.call('session/resume', { sessionId, cwd, mcpServers: [] });
        return { method: 'resume', result };
      } catch (err) {
        if (supportsLoad && err instanceof AcpProtocolError && err.code === -32601) {
          const result = await this.call('session/load', { sessionId, cwd, mcpServers: [] });
          return { method: 'load', result };
        }
        throw err;
      }
    }

    const result = await this.call('session/load', { sessionId, cwd, mcpServers: [] });
    return { method: 'load', result };
  }

  /**
   * Sends a prompt turn. Prompts may run long, so no default timeout unless
   * overridden.
   * @param {string} sessionId @param {object[]} prompt ContentBlock[]
   * @returns {Promise<{stopReason:string}>}
   */
  sessionPrompt(sessionId, prompt) {
    return this.call('session/prompt', { sessionId, prompt }, { timeoutMs: null });
  }

  /** @param {string} sessionId */
  sessionCancel(sessionId) {
    this.notify('session/cancel', { sessionId });
  }

  /**
   * @returns {boolean} whether the agent advertised support for image
   * content blocks in prompts (agentCapabilities.promptCapabilities.image).
   */
  supportsImages() {
    return !!this._serverCapabilities?.promptCapabilities?.image;
  }

  /** @param {string} sessionId */
  async sessionClose(sessionId) {
    if (!this._serverCapabilities?.sessionCapabilities?.close) {
      return null;
    }
    try {
      return await this.call('session/close', { sessionId }, { timeoutMs: 5000 });
    } catch (err) {
      if (err instanceof AcpProtocolError && err.code === -32601) return null;
      throw err;
    }
  }

  /** Terminates the child process. */
  close() {
    if (this._child && !this._exited) {
      try {
        this._child.stdin.end();
      } catch {
        // ignore
      }
      this._child.kill('SIGTERM');
    }
  }
}
