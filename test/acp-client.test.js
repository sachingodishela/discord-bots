import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AcpClient,
  AcpChildExitError,
  AcpTimeoutError,
  AcpProtocolVersionError,
  AcpUnsupportedError,
  AcpSpawnError,
} from '../src/acp/client.js';
import { createLogger } from '../src/logger.js';

const FIXTURE_PATH = fileURLToPath(new URL('./fixtures/mock-acp-agent.js', import.meta.url));

const silentLogger = createLogger({ logLevel: 'error' }, { write: () => {} });

function spawnFixture() {
  return spawn(process.execPath, [FIXTURE_PATH], { stdio: ['pipe', 'pipe', 'pipe'] });
}

function makeClient() {
  return new AcpClient({
    copilotBin: 'unused',
    cwd: '/home/sachin',
    logger: silentLogger,
    spawnImpl: () => spawnFixture(),
  }).start();
}

/**
 * Minimal in-process fake child_process, duck-typing just enough of the
 * ChildProcess surface (stdin/stdout/stderr streams, 'exit'/'error' events,
 * kill()) for AcpClient's unit tests that need precise control over the
 * initialize() response/capabilities or spawn failures, without the cost
 * and non-determinism of spawning a real subprocess per scenario.
 */
function makeFakeChild() {
  const child = new EventEmitter();
  const writes = [];
  child.stdin = {
    write(data) {
      writes.push(data);
      for (const line of data.split('\n')) {
        if (!line.trim()) continue;
        child.emit('_written', JSON.parse(line));
      }
      return true;
    },
    end() {},
  };
  child.stdout = new EventEmitter();
  child.stdout.setEncoding = () => {};
  child.stderr = new EventEmitter();
  child.stderr.setEncoding = () => {};
  child.kill = () => {
    child.emit('exit', null, 'SIGTERM');
  };
  child.writes = writes;
  /** Sends a raw NDJSON line back on stdout, as the agent would. */
  child.reply = (obj) => child.stdout.emit('data', `${JSON.stringify(obj)}\n`);
  /** Waits for and returns the next outgoing request matching `method`. */
  child.nextWritten = (method) =>
    new Promise((resolve) => {
      const existing = writes
        .flatMap((d) => d.split('\n').filter(Boolean).map((l) => JSON.parse(l)))
        .find((m) => m.method === method);
      if (existing) {
        resolve(existing);
        return;
      }
      child.on('_written', function handler(msg) {
        if (msg.method === method) {
          child.off('_written', handler);
          resolve(msg);
        }
      });
    });
  return child;
}

function makeFakeClient(fakeChild) {
  return new AcpClient({
    copilotBin: 'unused',
    cwd: '/home/sachin',
    logger: silentLogger,
    spawnImpl: () => fakeChild,
  }).start();
}

describe('AcpClient against mock ACP fixture', () => {
  test('initialize, session/new, and session/prompt round-trip with streamed update', async () => {
    const client = makeClient();
    try {
      const initResult = await client.initialize();
      assert.equal(initResult.protocolVersion, 1);

      const sessionId = await client.sessionNew('/home/sachin');
      assert.equal(sessionId, 'sess-abc123');

      const updates = [];
      client.on('notification', (method, params) => {
        if (method === 'session/update') updates.push(params.update);
      });
      const result = await client.sessionPrompt(sessionId, [{ type: 'text', text: 'hello' }]);
      assert.equal(result.stopReason, 'end_turn');
      assert.equal(updates.length, 1);
      assert.equal(updates[0].content.text, 'echo: hello');
    } finally {
      client.close();
    }
  });

  test('session/resume falls back to session/load on method-not-found', async () => {
    const client = makeClient();
    try {
      await client.initialize();
      const { method, result } = await client.sessionResume('unsupported-resume', '/home/sachin');
      assert.equal(method, 'load');
      assert.equal(result, null);
    } finally {
      client.close();
    }
  });

  test('session/resume surfaces non-recoverable errors without falling back', async () => {
    const client = makeClient();
    try {
      await client.initialize();
      await assert.rejects(() => client.sessionResume('broken-session', '/home/sachin'));
    } finally {
      client.close();
    }
  });

  test('reverse request session/request_permission is dispatched and response relayed back', async () => {
    const client = makeClient();
    try {
      await client.initialize();
      const sessionId = await client.sessionNew('/home/sachin');

      client.on('reverse-request', (method, params, respond) => {
        assert.equal(method, 'session/request_permission');
        assert.equal(params.toolCall.title, 'Run rm -rf');
        respond({ outcome: { outcome: 'selected', optionId: 'allow-once-opt' } });
      });

      const updates = [];
      client.on('notification', (method, params) => {
        if (method === 'session/update') updates.push(params.update);
      });

      const result = await client.sessionPrompt(sessionId, [{ type: 'text', text: '__PERMISSION__ do it' }]);
      assert.equal(result.stopReason, 'end_turn');
      assert.match(updates[0].content.text, /allow-once-opt/);
    } finally {
      client.close();
    }
  });

  test('session/cancel notification allows a pending prompt to resolve as cancelled', async () => {
    const client = makeClient();
    try {
      await client.initialize();
      const sessionId = await client.sessionNew('/home/sachin');
      const promptPromise = client.sessionPrompt(sessionId, [{ type: 'text', text: '__SLOW__ wait' }]);
      // Give the fixture a moment to register the pending slow prompt id.
      await new Promise((r) => setTimeout(r, 100));
      client.sessionCancel(sessionId);
      const result = await promptPromise;
      assert.equal(result.stopReason, 'cancelled');
    } finally {
      client.close();
    }
  });

  test('unexpected child exit rejects pending requests with AcpChildExitError', async () => {
    const client = makeClient();
    await client.initialize();
    const exitPromise = new Promise((resolve) => client.on('exit', resolve));
    const callPromise = client.call('crash-me', {}, { timeoutMs: 2000 });
    await assert.rejects(() => callPromise, AcpChildExitError);
    await exitPromise;
  });

  test('call() with explicit short timeout rejects with AcpTimeoutError when no response arrives', async () => {
    const client = makeClient();
    try {
      await client.initialize();
      const sessionId = await client.sessionNew('/home/sachin');
      await assert.rejects(
        () => client.call('session/prompt', { sessionId, prompt: [{ type: 'text', text: '__SLOW__ x' }] }, { timeoutMs: 200 }),
        AcpTimeoutError,
      );
    } finally {
      client.close();
    }
  });
});

describe('AcpClient capability negotiation', () => {
  test('initialize omits fs/terminal client capabilities (never advertises false)', async () => {
    const fakeChild = makeFakeChild();
    const client = makeFakeClient(fakeChild);
    const initPromise = client.initialize();
    const req = await fakeChild.nextWritten('initialize');
    assert.ok(!('fs' in req.params.clientCapabilities), 'fs capability must be omitted, not set to false');
    assert.ok(!('terminal' in req.params.clientCapabilities), 'terminal capability must be omitted, not set to false');
    fakeChild.reply({ jsonrpc: '2.0', id: req.id, result: { protocolVersion: 1, agentCapabilities: {} } });
    await initPromise;
  });

  test('initialize rejects with AcpProtocolVersionError on a protocolVersion mismatch', async () => {
    const fakeChild = makeFakeChild();
    const client = makeFakeClient(fakeChild);
    const initPromise = client.initialize();
    const req = await fakeChild.nextWritten('initialize');
    fakeChild.reply({ jsonrpc: '2.0', id: req.id, result: { protocolVersion: 999, agentCapabilities: {} } });
    await assert.rejects(() => initPromise, AcpProtocolVersionError);
  });

  test('sessionResume throws AcpUnsupportedError when the agent advertises neither resume nor load', async () => {
    const fakeChild = makeFakeChild();
    const client = makeFakeClient(fakeChild);
    const initPromise = client.initialize();
    const req = await fakeChild.nextWritten('initialize');
    fakeChild.reply({ jsonrpc: '2.0', id: req.id, result: { protocolVersion: 1, agentCapabilities: {} } });
    await initPromise;

    await assert.rejects(() => client.sessionResume('sess-1', '/home/sachin'), AcpUnsupportedError);
    assert.equal(fakeChild.writes.some((w) => w.includes('session/resume')), false);
    assert.equal(fakeChild.writes.some((w) => w.includes('session/load')), false);
  });

  test('sessionResume calls only session/load when the agent advertises loadSession but not resume', async () => {
    const fakeChild = makeFakeChild();
    const client = makeFakeClient(fakeChild);
    const initPromise = client.initialize();
    const req = await fakeChild.nextWritten('initialize');
    fakeChild.reply({ jsonrpc: '2.0', id: req.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } });
    await initPromise;

    const resumePromise = client.sessionResume('sess-1', '/home/sachin');
    const loadReq = await fakeChild.nextWritten('session/load');
    assert.equal(fakeChild.writes.some((w) => w.includes('"method":"session/resume"')), false, 'must not attempt session/resume when unsupported');
    fakeChild.reply({ jsonrpc: '2.0', id: loadReq.id, result: {} });
    const { method } = await resumePromise;
    assert.equal(method, 'load');
  });

  test('sessionResume calls session/resume when advertised', async () => {
    const fakeChild = makeFakeChild();
    const client = makeFakeClient(fakeChild);
    const initPromise = client.initialize();
    const req = await fakeChild.nextWritten('initialize');
    fakeChild.reply({
      jsonrpc: '2.0',
      id: req.id,
      result: { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { resume: true } } },
    });
    await initPromise;

    const resumePromise = client.sessionResume('sess-1', '/home/sachin');
    const resumeReq = await fakeChild.nextWritten('session/resume');
    fakeChild.reply({ jsonrpc: '2.0', id: resumeReq.id, result: {} });
    const { method } = await resumePromise;
    assert.equal(method, 'resume');
  });

  test('sessionClose is a no-op (no RPC sent) when the agent does not advertise close support', async () => {
    const fakeChild = makeFakeChild();
    const client = makeFakeClient(fakeChild);
    const initPromise = client.initialize();
    const req = await fakeChild.nextWritten('initialize');
    fakeChild.reply({ jsonrpc: '2.0', id: req.id, result: { protocolVersion: 1, agentCapabilities: {} } });
    await initPromise;

    const result = await client.sessionClose('sess-1');
    assert.equal(result, null);
    assert.equal(fakeChild.writes.some((w) => w.includes('session/close')), false);
  });

  test('sessionClose sends session/close when advertised', async () => {
    const fakeChild = makeFakeChild();
    const client = makeFakeClient(fakeChild);
    const initPromise = client.initialize();
    const req = await fakeChild.nextWritten('initialize');
    fakeChild.reply({
      jsonrpc: '2.0',
      id: req.id,
      result: { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { close: true } } },
    });
    await initPromise;

    const closePromise = client.sessionClose('sess-1');
    const closeReq = await fakeChild.nextWritten('session/close');
    fakeChild.reply({ jsonrpc: '2.0', id: closeReq.id, result: {} });
    await closePromise;
  });

  test('supportsImages() reflects agentCapabilities.promptCapabilities.image', async () => {
    for (const image of [true, false]) {
      const fakeChild = makeFakeChild();
      const client = makeFakeClient(fakeChild);
      const initPromise = client.initialize();
      const req = await fakeChild.nextWritten('initialize');
      fakeChild.reply({ jsonrpc: '2.0', id: req.id, result: { protocolVersion: 1, agentCapabilities: { promptCapabilities: { image } } } });
      await initPromise;
      assert.equal(client.supportsImages(), image);
    }
  });

  test('supportsImages() is false before initialize() has completed', () => {
    const fakeChild = makeFakeChild();
    const client = makeFakeClient(fakeChild);
    assert.equal(client.supportsImages(), false);
  });
});

describe('AcpClient spawn/IO error handling', () => {
  test('a child "error" event (e.g. ENOENT) never crashes the process and rejects pending calls', async () => {
    const fakeChild = makeFakeChild();
    const client = makeFakeClient(fakeChild);
    // No 'error' listener registered on the client - this must not throw.
    const callPromise = client.call('initialize', {}, { timeoutMs: 2000 });
    const spawnErr = new Error('spawn copilot ENOENT');
    fakeChild.emit('error', spawnErr);
    await assert.rejects(() => callPromise, AcpSpawnError);
  });

  test('a spawn error also rejects a subsequently-pending call and marks the client exited', async () => {
    const fakeChild = makeFakeChild();
    const client = makeFakeClient(fakeChild);
    fakeChild.emit('error', new Error('spawn copilot ENOENT'));
    await assert.rejects(() => client.call('initialize', {}), AcpSpawnError);
  });

  test('when an "error" listener is registered, it still receives the raw error (no crash either way)', async () => {
    const fakeChild = makeFakeChild();
    const client = makeFakeClient(fakeChild);
    const seen = [];
    client.on('error', (err) => seen.push(err));
    const callPromise = client.call('initialize', {}, { timeoutMs: 2000 });
    fakeChild.emit('error', new Error('boom'));
    await assert.rejects(() => callPromise, AcpSpawnError);
    assert.equal(seen.length, 1);
    assert.match(seen[0].message, /boom/);
  });
});
