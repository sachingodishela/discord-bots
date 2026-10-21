/**
 * Discord Gateway v10 client (WebSocket), using Node's global WebSocket.
 *
 * Implements: HELLO, heartbeat + ACK tracking (reconnects on missed ACK),
 * IDENTIFY, READY, sequence tracking, RESUME, RECONNECT, INVALID_SESSION,
 * exponential backoff with jitter, and clean shutdown. Dispatches decoded
 * events via a small EventEmitter-style interface.
 *
 * Socket lifecycle safety: every socket created by `_open()` is tagged with
 * a monotonically increasing generation number. All of that socket's event
 * listeners check the generation against the client's current generation
 * before doing anything, so events from a stale/retired socket (e.g. a slow
 * close that fires after we've already moved on) are ignored and can never
 * schedule a duplicate reconnect or leave two live sockets around. `_open()`
 * always retires (closes) any still-open/connecting previous socket first.
 */
import { EventEmitter } from 'node:events';

const GATEWAY_URL = 'wss://gateway.discord.gg/?v=10&encoding=json';

const OP = {
  DISPATCH: 0,
  HEARTBEAT: 1,
  IDENTIFY: 2,
  RESUME: 6,
  RECONNECT: 7,
  INVALID_SESSION: 9,
  HELLO: 10,
  HEARTBEAT_ACK: 11,
};

// GUILDS | GUILD_MESSAGES | MESSAGE_CONTENT
const INTENTS = (1 << 0) | (1 << 9) | (1 << 15);

const MAX_BACKOFF_MS = 60_000;

/**
 * Ensures a resume gateway URL carries the required API version/encoding
 * query params, as Discord's `resume_gateway_url` is not guaranteed to
 * include them.
 * @param {string|null|undefined} url
 * @returns {string|null}
 */
function normalizeResumeGatewayUrl(url) {
  if (!url) return url ?? null;
  return url.includes('?') ? url : `${url}?v=10&encoding=json`;
}

export class GatewayClient extends EventEmitter {
  /**
   * @param {{token:string, logger:import('../logger.js').Logger, stateStore?:import('../state/store.js').StateStore, WebSocketImpl?: typeof WebSocket, url?: string, setTimeoutImpl?: typeof setTimeout, clearTimeoutImpl?: typeof clearTimeout, setIntervalImpl?: typeof setInterval, clearIntervalImpl?: typeof clearInterval, randomImpl?: () => number}} opts
   */
  constructor(opts) {
    super();
    this._token = opts.token;
    this.logger = opts.logger.child({ component: 'gateway' });
    this._stateStore = opts.stateStore;
    this._WebSocketImpl = opts.WebSocketImpl || WebSocket;
    this._url = opts.url || GATEWAY_URL;
    this._setTimeout = opts.setTimeoutImpl || setTimeout;
    this._clearTimeout = opts.clearTimeoutImpl || clearTimeout;
    this._setInterval = opts.setIntervalImpl || setInterval;
    this._clearInterval = opts.clearIntervalImpl || clearInterval;
    this._random = opts.randomImpl || Math.random;

    this._ws = null;
    /** Generation counter: bumped every time `_open()` creates a new socket. */
    this._generation = 0;
    this._heartbeatIntervalMs = null;
    this._heartbeatTimer = null;
    /** Timeout for the jittered *first* heartbeat after HELLO/reconnect. */
    this._heartbeatJitterTimer = null;
    this._ackReceived = true;
    this._seq = null;
    this._sessionId = null;
    this._resumeGatewayUrl = null;
    this._reconnectAttempt = 0;
    this._reconnectTimer = null;
    this._shuttingDown = false;
    this._identifyBackoffTimer = null;
  }

  /** Restores persisted resume state (session id / seq / resume url), if any. */
  loadResumeState(gateway) {
    if (!gateway) return;
    this._sessionId = gateway.sessionId ?? null;
    this._seq = gateway.seq ?? null;
    this._resumeGatewayUrl = normalizeResumeGatewayUrl(gateway.resumeGatewayUrl ?? null);
  }

  /** @returns {{sessionId:string|null, seq:number|null, resumeGatewayUrl:string|null}} */
  getResumeState() {
    return { sessionId: this._sessionId, seq: this._seq, resumeGatewayUrl: this._resumeGatewayUrl };
  }

  connect() {
    this._shuttingDown = false;
    this._open(this._nextConnectUrl());
  }

  /** @private @returns {string} the resume URL if we have session state to resume, else the base gateway URL */
  _nextConnectUrl() {
    return this._sessionId && this._resumeGatewayUrl ? this._resumeGatewayUrl : this._url;
  }

  /**
   * Closes a socket we no longer consider "current" without letting its
   * close event (if any) be treated as a live disconnect. Because the
   * generation is bumped by the caller *before* this runs, the socket's own
   * listeners (which check generation) will already treat themselves as
   * stale by the time `close()` synchronously/asynchronously fires them.
   * @private @param {WebSocket|null} ws
   */
  _retire(ws) {
    if (!ws) return;
    const OPEN = this._WebSocketImpl.OPEN;
    const CONNECTING = this._WebSocketImpl.CONNECTING;
    if (ws.readyState === OPEN || ws.readyState === CONNECTING) {
      try {
        ws.close(1000, 'superseded');
      } catch {
        // socket may already be closing/closed
      }
    }
  }

  /** @private @param {string} url */
  _open(url) {
    const previous = this._ws;
    // Bump the generation before touching the previous socket so that any
    // (sync or async) events it fires from here on are recognized as stale.
    const gen = ++this._generation;
    this._ws = null;
    this._retire(previous);
    // Any heartbeat scheduling belonged to the socket we just retired (whose
    // own close handler will now be ignored as stale) - clear it explicitly
    // so opening a fresh connection never leaves a stale heartbeat/jitter
    // timer running alongside the new connection's own.
    this._clearInterval(this._heartbeatTimer);
    this._clearTimeout(this._heartbeatJitterTimer);

    this.logger.info('connecting', { resuming: !!this._sessionId });
    const ws = new this._WebSocketImpl(url);
    ws._gatewayGeneration = gen;
    this._ws = ws;

    const isCurrent = () => ws._gatewayGeneration === this._generation;

    ws.addEventListener('open', () => {
      if (!isCurrent()) return;
      this.logger.debug('ws open');
    });
    ws.addEventListener('message', (ev) => {
      if (!isCurrent()) return;
      this._onMessage(ev);
    });
    ws.addEventListener('close', (ev) => {
      if (!isCurrent()) return;
      this._onClose(ev);
    });
    ws.addEventListener('error', (ev) => {
      if (!isCurrent()) return;
      this.logger.warn('ws error', { message: ev?.message });
    });
  }

  /** @private @param {MessageEvent} ev */
  _onMessage(ev) {
    let payload;
    try {
      payload = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString());
    } catch (err) {
      this.logger.warn('failed to parse gateway payload', { error: err.message });
      return;
    }
    this._handlePayload(payload);
  }

  /** @private @param {{op:number, d:any, s?:number, t?:string}} payload */
  _handlePayload(payload) {
    const { op, d, s, t } = payload;
    if (typeof s === 'number') this._seq = s;

    switch (op) {
      case OP.HELLO:
        this._heartbeatIntervalMs = d.heartbeat_interval;
        this._startHeartbeat();
        if (this._sessionId && this._resumeGatewayUrl) {
          this._resume();
        } else {
          this._identify();
        }
        break;
      case OP.HEARTBEAT_ACK:
        this._ackReceived = true;
        break;
      case OP.HEARTBEAT:
        this._sendHeartbeat();
        break;
      case OP.RECONNECT:
        this.logger.info('server requested reconnect');
        this._reconnect(true);
        break;
      case OP.INVALID_SESSION:
        this._handleInvalidSession(d);
        break;
      case OP.DISPATCH:
        this._handleDispatch(t, d);
        break;
      default:
        break;
    }
  }

  /**
   * Per Discord docs: on INVALID_SESSION, wait a short random delay, then
   * either RESUME (if resumable) or re-IDENTIFY, on a *fresh* connection -
   * never by pushing RESUME/IDENTIFY back down the (potentially already
   * invalid) socket that received the INVALID_SESSION payload.
   * @private @param {boolean} resumable
   */
  _handleInvalidSession(resumable) {
    const canResume = resumable === true;
    this.logger.warn('invalid session', { resumable: canResume });
    if (!canResume) {
      this._sessionId = null;
      this._resumeGatewayUrl = null;
      this._seq = null;
      this._persistResumeState();
    }
    // Only one of {identify-backoff, reconnect} timer should ever be live.
    this._clearTimeout(this._reconnectTimer);
    this._clearTimeout(this._identifyBackoffTimer);
    const delay = 1000 + this._random() * 4000;
    this._identifyBackoffTimer = this._setTimeout(() => {
      if (this._shuttingDown) return;
      this._open(this._nextConnectUrl());
    }, delay);
  }

  /** @private @param {string} t @param {any} d */
  _handleDispatch(t, d) {
    if (t === 'READY') {
      this._sessionId = d.session_id;
      this._resumeGatewayUrl = normalizeResumeGatewayUrl(d.resume_gateway_url);
      this._reconnectAttempt = 0;
      this._persistResumeState();
      this.logger.info('ready', { sessionId: shortId(this._sessionId) });
    }
    if (t === 'RESUMED') {
      this._reconnectAttempt = 0;
      this.logger.info('resumed');
    }
    this._persistResumeState();
    this.emit('dispatch', t, d);
  }

  /** @private */
  _persistResumeState() {
    if (!this._stateStore) return;
    this._stateStore.setGateway(this.getResumeState());
  }

  /** @private */
  _identify() {
    this._send({
      op: OP.IDENTIFY,
      d: {
        token: this._token,
        intents: INTENTS,
        properties: { os: 'linux', browser: 'discord-copilot-broker', device: 'discord-copilot-broker' },
      },
    });
  }

  /** @private */
  _resume() {
    this._send({
      op: OP.RESUME,
      d: { token: this._token, session_id: this._sessionId, seq: this._seq },
    });
  }

  /** @private */
  _startHeartbeat() {
    this._clearInterval(this._heartbeatTimer);
    this._clearTimeout(this._heartbeatJitterTimer);
    this._ackReceived = true;
    // Discord recommends jittering the first heartbeat.
    const jitter = this._random();
    this._heartbeatJitterTimer = this._setTimeout(() => {
      if (this._shuttingDown) return;
      this._sendHeartbeat();
      this._heartbeatTimer = this._setInterval(() => this._heartbeatTick(), this._heartbeatIntervalMs);
    }, this._heartbeatIntervalMs * jitter);
  }

  /** @private */
  _heartbeatTick() {
    if (!this._ackReceived) {
      this.logger.warn('heartbeat ACK timeout, reconnecting');
      this._reconnect(false);
      return;
    }
    this._sendHeartbeat();
  }

  /** @private */
  _sendHeartbeat() {
    this._ackReceived = false;
    this._send({ op: OP.HEARTBEAT, d: this._seq });
  }

  /** @private @param {object} obj */
  _send(obj) {
    if (!this._ws || this._ws.readyState !== this._WebSocketImpl.OPEN) return;
    this._ws.send(JSON.stringify(obj));
  }

  /** @private @param {CloseEvent} ev */
  _onClose(ev) {
    this._clearInterval(this._heartbeatTimer);
    this._clearTimeout(this._heartbeatJitterTimer);
    this.logger.warn('ws closed', { code: ev?.code, reason: ev?.reason });
    if (this._shuttingDown) return;
    // 4004 auth failed, 4014 disallowed intents, 4010-4013 non-recoverable.
    const nonRecoverable = new Set([4004, 4010, 4011, 4012, 4013, 4014]);
    if (nonRecoverable.has(ev?.code)) {
      this.emit('fatal', new Error(`Gateway closed with non-recoverable code ${ev.code}`));
      return;
    }
    if (ev?.code === 4007 || ev?.code === 4009) {
      this._sessionId = null;
      this._resumeGatewayUrl = null;
      this._seq = null;
      this._persistResumeState();
    }
    this._reconnect(false);
  }

  /** @private @param {boolean} immediate */
  _reconnect(immediate) {
    if (this._shuttingDown) return;
    // Only one of {reconnect, identify-backoff} timer should ever be live.
    this._clearTimeout(this._reconnectTimer);
    this._clearTimeout(this._identifyBackoffTimer);
    const attempt = this._reconnectAttempt++;
    const delay = immediate ? 0 : Math.min(MAX_BACKOFF_MS, 1000 * 2 ** attempt) + this._random() * 1000;
    this._reconnectTimer = this._setTimeout(() => {
      if (this._shuttingDown) return;
      this._open(this._nextConnectUrl());
    }, delay);
  }

  /** Clean shutdown: stops timers and closes the socket with code 1000. */
  close() {
    this._shuttingDown = true;
    this._clearInterval(this._heartbeatTimer);
    this._clearTimeout(this._heartbeatJitterTimer);
    this._clearTimeout(this._reconnectTimer);
    this._clearTimeout(this._identifyBackoffTimer);
    // Bump the generation so any in-flight events from the current socket
    // (e.g. a close event dispatched after this point) are treated as stale.
    this._generation++;
    if (this._ws) {
      try {
        this._ws.close(1000, 'shutdown');
      } catch {
        // socket may already be closed
      }
    }
  }
}

/** @param {string|null} id */
function shortId(id) {
  if (!id) return id;
  return id.length > 8 ? `${id.slice(0, 8)}…` : id;
}

export { OP as GATEWAY_OPCODES, INTENTS as GATEWAY_INTENTS, normalizeResumeGatewayUrl };
