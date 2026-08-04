import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { GatewayClient, GATEWAY_OPCODES, GATEWAY_INTENTS, normalizeResumeGatewayUrl } from '../src/discord/gateway.js';
import { createLogger } from '../src/logger.js';

const silentLogger = createLogger({ logLevel: 'error' }, { write: () => {} });

class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  constructor(url) {
    this.url = url;
    this.readyState = FakeWebSocket.OPEN;
    this._listeners = {};
    this.sent = [];
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type, cb) {
    (this._listeners[type] ||= []).push(cb);
  }

  send(data) {
    this.sent.push(JSON.parse(data));
  }

  close(code, reason) {
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.readyState = FakeWebSocket.CLOSED;
    this._dispatch('close', { code, reason });
  }

  simulateMessage(obj) {
    this._dispatch('message', { data: JSON.stringify(obj) });
  }

  _dispatch(type, evt) {
    for (const cb of this._listeners[type] || []) cb(evt);
  }
}
FakeWebSocket.instances = [];

/** Deterministic fake clock: captures scheduled timeouts/intervals so tests can fire them manually. */
function makeFakeClock() {
  const timeouts = [];
  const intervals = [];
  return {
    setTimeoutImpl: (fn, ms) => {
      const rec = { fn, ms, cleared: false };
      timeouts.push(rec);
      return rec;
    },
    clearTimeoutImpl: (rec) => {
      if (rec) rec.cleared = true;
    },
    setIntervalImpl: (fn, ms) => {
      const rec = { fn, ms, cleared: false };
      intervals.push(rec);
      return rec;
    },
    clearIntervalImpl: (rec) => {
      if (rec) rec.cleared = true;
    },
    timeouts,
    intervals,
    lastTimeout: () => timeouts.filter((r) => !r.cleared).at(-1),
    lastInterval: () => intervals.filter((r) => !r.cleared).at(-1),
  };
}

function makeGateway(overrides = {}) {
  FakeWebSocket.instances = [];
  const clock = makeFakeClock();
  const gateway = new GatewayClient({
    token: 'fake-token',
    logger: silentLogger,
    WebSocketImpl: FakeWebSocket,
    randomImpl: () => 0, // remove jitter randomness for determinism
    ...clock,
    ...overrides,
  });
  return { gateway, clock };
}

describe('GatewayClient', () => {
  test('IDENTIFY is sent (with correct intents) after HELLO when no prior session', () => {
    const { gateway } = makeGateway();
    gateway.connect();
    const ws = FakeWebSocket.instances[0];
    ws.simulateMessage({ op: GATEWAY_OPCODES.HELLO, d: { heartbeat_interval: 41250 } });

    const identify = ws.sent.find((m) => m.op === GATEWAY_OPCODES.IDENTIFY);
    assert.ok(identify, 'expected an IDENTIFY payload');
    assert.equal(identify.d.token, 'fake-token');
    assert.equal(identify.d.intents, GATEWAY_INTENTS);
    assert.equal(GATEWAY_INTENTS, (1 << 0) | (1 << 9) | (1 << 15));
  });

  test('RESUME is sent instead of IDENTIFY when prior session state was loaded', () => {
    const { gateway } = makeGateway();
    gateway.loadResumeState({ sessionId: 'sess-1', seq: 7, resumeGatewayUrl: 'wss://resume.example?v=10&encoding=json' });
    gateway.connect();
    const ws = FakeWebSocket.instances[0];
    assert.equal(ws.url, 'wss://resume.example?v=10&encoding=json');
    ws.simulateMessage({ op: GATEWAY_OPCODES.HELLO, d: { heartbeat_interval: 41250 } });

    const resume = ws.sent.find((m) => m.op === GATEWAY_OPCODES.RESUME);
    assert.ok(resume, 'expected a RESUME payload');
    assert.equal(resume.d.session_id, 'sess-1');
    assert.equal(resume.d.seq, 7);
  });

  test('loadResumeState normalizes a resume URL missing query params', () => {
    const { gateway } = makeGateway();
    gateway.loadResumeState({ sessionId: 'sess-1', seq: 7, resumeGatewayUrl: 'wss://resume.example' });
    assert.equal(gateway.getResumeState().resumeGatewayUrl, 'wss://resume.example?v=10&encoding=json');
  });

  test('normalizeResumeGatewayUrl leaves URLs with existing query params untouched', () => {
    assert.equal(normalizeResumeGatewayUrl('wss://resume.example?v=10&encoding=json'), 'wss://resume.example?v=10&encoding=json');
    assert.equal(normalizeResumeGatewayUrl('wss://resume.example'), 'wss://resume.example?v=10&encoding=json');
    assert.equal(normalizeResumeGatewayUrl(null), null);
  });

  test('READY dispatch stores resume state (normalized) and persists it to the state store', () => {
    const persisted = [];
    const fakeStateStore = { setGateway: (g) => persisted.push(g) };
    const { gateway } = makeGateway({ stateStore: fakeStateStore });
    gateway.connect();
    const ws = FakeWebSocket.instances[0];
    ws.simulateMessage({
      op: GATEWAY_OPCODES.DISPATCH,
      s: 1,
      t: 'READY',
      d: { session_id: 'new-session', resume_gateway_url: 'wss://resume2.example', user: { id: 'bot-id' } },
    });

    const state = gateway.getResumeState();
    assert.equal(state.sessionId, 'new-session');
    assert.equal(state.resumeGatewayUrl, 'wss://resume2.example?v=10&encoding=json');
    assert.ok(persisted.length > 0);
    assert.equal(persisted.at(-1).sessionId, 'new-session');
    assert.equal(persisted.at(-1).resumeGatewayUrl, 'wss://resume2.example?v=10&encoding=json');
  });

  test('emits dispatch events for downstream consumption', () => {
    const { gateway } = makeGateway();
    gateway.connect();
    const ws = FakeWebSocket.instances[0];
    const received = [];
    gateway.on('dispatch', (t, d) => received.push([t, d]));
    ws.simulateMessage({ op: GATEWAY_OPCODES.DISPATCH, s: 5, t: 'MESSAGE_CREATE', d: { content: 'hi' } });
    assert.equal(received.length, 1);
    assert.equal(received[0][0], 'MESSAGE_CREATE');
  });

  test('heartbeat ACK timeout triggers a reconnect on a fresh socket, retiring the old one', () => {
    const { gateway, clock } = makeGateway();
    gateway.connect();
    const ws = FakeWebSocket.instances[0];
    ws.simulateMessage({ op: GATEWAY_OPCODES.HELLO, d: { heartbeat_interval: 1000 } });

    // Fire the jittered first-heartbeat timeout: sends a heartbeat and starts the interval.
    clock.lastTimeout().fn();
    assert.ok(ws.sent.some((m) => m.op === GATEWAY_OPCODES.HEARTBEAT));

    // No HEARTBEAT_ACK arrives; next interval tick should detect the missed ACK and
    // schedule a reconnect (a new timeout beyond the heartbeat ones already fired).
    const timeoutCountBefore = clock.timeouts.filter((t) => !t.cleared).length;
    clock.lastInterval().fn();
    const scheduledReconnect = clock.lastTimeout();
    assert.notEqual(clock.timeouts.filter((t) => !t.cleared).length, timeoutCountBefore, 'expected a new reconnect timeout to be scheduled');

    // Firing the scheduled reconnect should open a brand new connection and retire the old one.
    scheduledReconnect.fn();
    assert.equal(FakeWebSocket.instances.length, 2);
    assert.equal(ws.readyState, FakeWebSocket.CLOSED, 'expected the stale socket to be closed');
  });

  test('HEARTBEAT_ACK clears the missed-ack flag so no reconnect happens', () => {
    const { gateway, clock } = makeGateway();
    gateway.connect();
    const ws = FakeWebSocket.instances[0];
    ws.simulateMessage({ op: GATEWAY_OPCODES.HELLO, d: { heartbeat_interval: 1000 } });
    clock.lastTimeout().fn(); // sends first heartbeat, starts interval
    ws.simulateMessage({ op: GATEWAY_OPCODES.HEARTBEAT_ACK });

    const reconnectSpy = [];
    const originalOpen = gateway._open.bind(gateway);
    gateway._open = (...args) => {
      reconnectSpy.push(args);
      return originalOpen(...args);
    };
    clock.lastInterval().fn(); // tick: ACK was received, should just send another heartbeat
    assert.equal(reconnectSpy.length, 0);
  });

  test('RECONNECT opcode causes the client to open a new connection and retire the old socket', () => {
    const { gateway, clock } = makeGateway();
    gateway.connect();
    const ws = FakeWebSocket.instances[0];
    ws.simulateMessage({ op: GATEWAY_OPCODES.RECONNECT });
    // immediate reconnect is scheduled with delay 0 via setTimeoutImpl
    clock.lastTimeout().fn();
    assert.equal(FakeWebSocket.instances.length, 2);
    assert.equal(ws.readyState, FakeWebSocket.CLOSED);
  });

  test('stale events from a retired socket are ignored (no duplicate dispatch/reconnect)', () => {
    const { gateway, clock } = makeGateway();
    gateway.connect();
    const oldWs = FakeWebSocket.instances[0];
    ws_hello(oldWs);

    // Force a reconnect: this retires oldWs and opens a new one.
    oldWs.simulateMessage({ op: GATEWAY_OPCODES.RECONNECT });
    clock.lastTimeout().fn();
    assert.equal(FakeWebSocket.instances.length, 2);
    const newWs = FakeWebSocket.instances[1];

    const received = [];
    gateway.on('dispatch', (t, d) => received.push([t, d]));

    // The old (now-retired, closed) socket somehow still fires a message event
    // (e.g. a queued microtask from before it was closed) - it must be ignored.
    oldWs._dispatch('message', { data: JSON.stringify({ op: GATEWAY_OPCODES.DISPATCH, t: 'MESSAGE_CREATE', d: {} }) });
    assert.equal(received.length, 0, 'stale dispatch from retired socket must be ignored');

    // And a stale close event from the old socket must not schedule another reconnect.
    const timeoutsBefore = clock.timeouts.filter((t) => !t.cleared).length;
    oldWs._dispatch('close', { code: 1006, reason: 'stale' });
    assert.equal(clock.timeouts.filter((t) => !t.cleared).length, timeoutsBefore, 'stale close must not schedule a new reconnect');

    // The new socket is still fully functional.
    newWs.simulateMessage({ op: GATEWAY_OPCODES.DISPATCH, t: 'MESSAGE_CREATE', d: { content: 'hi' } });
    assert.equal(received.length, 1);
  });

  test('opening a new connection always closes a still-open previous socket first', () => {
    const { gateway, clock } = makeGateway();
    gateway.connect();
    const first = FakeWebSocket.instances[0];
    assert.equal(first.readyState, FakeWebSocket.OPEN);

    gateway._reconnect(true);
    clock.lastTimeout().fn();

    assert.equal(FakeWebSocket.instances.length, 2);
    assert.equal(first.readyState, FakeWebSocket.CLOSED, 'previous socket must be closed before opening another');
    assert.equal(gateway._ws, FakeWebSocket.instances[1]);
  });

  test('heartbeat jitter timeout is cleared on reconnect and on close (no leaked timers)', () => {
    const { gateway, clock } = makeGateway();
    gateway.connect();
    const ws = FakeWebSocket.instances[0];
    ws.simulateMessage({ op: GATEWAY_OPCODES.HELLO, d: { heartbeat_interval: 1000 } });
    const firstJitterTimer = clock.lastTimeout();
    assert.equal(firstJitterTimer.cleared, false);

    // Reconnecting (e.g. RECONNECT opcode) should clear the pending jitter timer.
    ws.simulateMessage({ op: GATEWAY_OPCODES.RECONNECT });
    clock.lastTimeout().fn(); // fires the reconnect timeout, opens a new socket
    assert.equal(firstJitterTimer.cleared, true, 'expected the first heartbeat jitter timer to be cleared on reconnect');

    const newWs = FakeWebSocket.instances[1];
    newWs.simulateMessage({ op: GATEWAY_OPCODES.HELLO, d: { heartbeat_interval: 1000 } });
    const secondJitterTimer = clock.lastTimeout();
    assert.equal(secondJitterTimer.cleared, false);

    gateway.close();
    assert.equal(secondJitterTimer.cleared, true, 'expected close() to clear a pending heartbeat jitter timer');
  });

  test('INVALID_SESSION (not resumable) clears session state and re-identifies on a fresh connection', () => {
    const { gateway, clock } = makeGateway();
    gateway.loadResumeState({ sessionId: 'sess-1', seq: 3, resumeGatewayUrl: 'wss://resume.example?v=10&encoding=json' });
    gateway.connect();
    const ws = FakeWebSocket.instances[0];
    ws.simulateMessage({ op: GATEWAY_OPCODES.INVALID_SESSION, d: false });

    assert.equal(gateway.getResumeState().sessionId, null);
    // The backoff timer must NOT send RESUME/IDENTIFY directly on the (invalid) socket.
    const backoffTimer = clock.lastTimeout();
    backoffTimer.fn();
    assert.equal(ws.sent.find((m) => m.op === GATEWAY_OPCODES.IDENTIFY), undefined, 'must not identify on the old/invalid socket');

    // Instead, a fresh socket must have been opened (using the plain gateway URL, session cleared).
    assert.equal(FakeWebSocket.instances.length, 2);
    assert.equal(ws.readyState, FakeWebSocket.CLOSED);
    const newWs = FakeWebSocket.instances[1];
    assert.equal(newWs.url, gateway._url);

    newWs.simulateMessage({ op: GATEWAY_OPCODES.HELLO, d: { heartbeat_interval: 1000 } });
    const identify = newWs.sent.find((m) => m.op === GATEWAY_OPCODES.IDENTIFY);
    assert.ok(identify, 'expected IDENTIFY to be sent on the fresh connection');
  });

  test('INVALID_SESSION (resumable) preserves session state and resumes on a fresh connection', () => {
    const { gateway, clock } = makeGateway();
    gateway.loadResumeState({ sessionId: 'sess-1', seq: 3, resumeGatewayUrl: 'wss://resume.example?v=10&encoding=json' });
    gateway.connect();
    const ws = FakeWebSocket.instances[0];
    ws.simulateMessage({ op: GATEWAY_OPCODES.INVALID_SESSION, d: true });

    // Resumable: session state must be preserved.
    assert.equal(gateway.getResumeState().sessionId, 'sess-1');
    assert.equal(gateway.getResumeState().seq, 3);

    clock.lastTimeout().fn();

    assert.equal(FakeWebSocket.instances.length, 2, 'expected a fresh connection to be opened');
    assert.equal(ws.readyState, FakeWebSocket.CLOSED, 'the old socket must be retired');
    const newWs = FakeWebSocket.instances[1];
    assert.equal(newWs.url, 'wss://resume.example?v=10&encoding=json', 'fresh connection must target the resume URL');

    // No RESUME/IDENTIFY should have been sent on the old socket at all.
    assert.equal(ws.sent.length, 0);

    newWs.simulateMessage({ op: GATEWAY_OPCODES.HELLO, d: { heartbeat_interval: 1000 } });
    const resume = newWs.sent.find((m) => m.op === GATEWAY_OPCODES.RESUME);
    assert.ok(resume, 'expected RESUME to be sent on the fresh connection');
    assert.equal(resume.d.session_id, 'sess-1');
  });

  test('non-recoverable close code emits a fatal event instead of reconnecting', () => {
    const { gateway } = makeGateway();
    gateway.connect();
    const ws = FakeWebSocket.instances[0];
    let fatalErr = null;
    gateway.on('fatal', (err) => (fatalErr = err));
    ws.close(4004, 'Authentication failed');
    assert.ok(fatalErr);
    assert.match(fatalErr.message, /4004/);
  });

  test('close() performs a clean shutdown: closes the socket with code 1000 and stops timers', () => {
    const { gateway, clock } = makeGateway();
    gateway.connect();
    const ws = FakeWebSocket.instances[0];
    ws.simulateMessage({ op: GATEWAY_OPCODES.HELLO, d: { heartbeat_interval: 1000 } });
    clock.lastTimeout().fn();

    gateway.close();
    assert.equal(ws.readyState, FakeWebSocket.CLOSED);
    assert.ok(clock.intervals.every((i) => i.cleared));
    assert.ok(clock.timeouts.every((t) => t.cleared));
  });

  test('close() cannot be followed by a duplicate live socket from an in-flight reconnect timer', () => {
    const { gateway, clock } = makeGateway();
    gateway.connect();
    const ws = FakeWebSocket.instances[0];
    ws.simulateMessage({ op: GATEWAY_OPCODES.HELLO, d: { heartbeat_interval: 1000 } });
    clock.lastTimeout().fn();
    clock.lastInterval().fn(); // no ack -> schedules a reconnect timer

    gateway.close();

    // Even if the (already-cleared) reconnect timer's callback were invoked anyway,
    // it must be a no-op because _shuttingDown guards it.
    const reconnectTimer = clock.timeouts.at(-1);
    reconnectTimer.fn();
    assert.equal(FakeWebSocket.instances.length, 1, 'no new socket should be opened after close()');
  });
});

function ws_hello(ws, heartbeatIntervalMs = 1000) {
  ws.simulateMessage({ op: GATEWAY_OPCODES.HELLO, d: { heartbeat_interval: heartbeatIntervalMs } });
}
