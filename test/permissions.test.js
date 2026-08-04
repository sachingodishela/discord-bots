import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { PermissionManager } from '../src/acp/permissions.js';
import { createLogger } from '../src/logger.js';

const silentLogger = createLogger({ logLevel: 'error' }, { write: () => {} });

function makeFakeRest() {
  let nextId = 1;
  const messages = new Map();
  return {
    messages,
    async createThreadMessage(threadId, body) {
      const id = `msg-${nextId++}`;
      messages.set(id, { threadId, ...body });
      return { id, channel_id: threadId, ...body };
    },
    async editMessage(threadId, messageId, body) {
      const existing = messages.get(messageId) || {};
      messages.set(messageId, { ...existing, ...body });
      return { id: messageId, ...body };
    },
  };
}

function extractNonces(components) {
  const [row] = components;
  const [allowBtn, rejectBtn] = row.components;
  return {
    allow: allowBtn.custom_id.slice('perm:'.length),
    reject: rejectBtn.custom_id.slice('perm:'.length),
  };
}

describe('PermissionManager', () => {
  const OPERATOR = '710119698313773178';
  const OTHER_USER = '999999999999999999';

  function baseRequest(overrides = {}) {
    return {
      threadId: 'thread-1',
      requestId: 'req-1',
      toolCall: { title: 'Run something', kind: 'execute', rawInput: { cmd: 'ls' } },
      options: [
        { optionId: 'allow-1', kind: 'allow_once', name: 'Allow' },
        { optionId: 'reject-1', kind: 'reject_once', name: 'Reject' },
      ],
      ...overrides,
    };
  }

  test('allow click resolves with exact selected outcome shape', async () => {
    const rest = makeFakeRest();
    const pm = new PermissionManager({ restClient: rest, operatorUserId: OPERATOR, logger: silentLogger });
    const promise = pm.requestPermission(baseRequest());
    await new Promise((r) => setTimeout(r, 10));
    const [msgId, msg] = [...rest.messages.entries()][0];
    const { allow } = extractNonces(msg.components);

    const clickResult = pm.handleComponentClick({
      customId: `perm:${allow}`,
      userId: OPERATOR,
      channelId: 'thread-1',
      messageId: msgId,
    });
    assert.equal(clickResult.ok, true);

    const outcome = await promise;
    assert.deepEqual(outcome, { outcome: { outcome: 'selected', optionId: 'allow-1' } });
  });

  test('reject click resolves with reject optionId', async () => {
    const rest = makeFakeRest();
    const pm = new PermissionManager({ restClient: rest, operatorUserId: OPERATOR, logger: silentLogger });
    const promise = pm.requestPermission(baseRequest());
    await new Promise((r) => setTimeout(r, 10));
    const [msgId, msg] = [...rest.messages.entries()][0];
    const { reject } = extractNonces(msg.components);

    pm.handleComponentClick({ customId: `perm:${reject}`, userId: OPERATOR, channelId: 'thread-1', messageId: msgId });
    const outcome = await promise;
    assert.deepEqual(outcome, { outcome: { outcome: 'selected', optionId: 'reject-1' } });
  });

  test('click from wrong user is rejected and does not resolve the pending request', async () => {
    const rest = makeFakeRest();
    const pm = new PermissionManager({ restClient: rest, operatorUserId: OPERATOR, logger: silentLogger });
    const promise = pm.requestPermission(baseRequest());
    await new Promise((r) => setTimeout(r, 10));
    const [msgId, msg] = [...rest.messages.entries()][0];
    const { allow } = extractNonces(msg.components);

    const result = pm.handleComponentClick({ customId: `perm:${allow}`, userId: OTHER_USER, channelId: 'thread-1', messageId: msgId });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'wrong-user');

    // Confirm it is still pending: a subsequent valid click still works.
    const validResult = pm.handleComponentClick({ customId: `perm:${allow}`, userId: OPERATOR, channelId: 'thread-1', messageId: msgId });
    assert.equal(validResult.ok, true);
    const outcome = await promise;
    assert.equal(outcome.outcome.optionId, 'allow-1');
  });

  test('click from wrong thread is rejected', async () => {
    const rest = makeFakeRest();
    const pm = new PermissionManager({ restClient: rest, operatorUserId: OPERATOR, logger: silentLogger });
    const promise = pm.requestPermission(baseRequest());
    await new Promise((r) => setTimeout(r, 10));
    const [msgId, msg] = [...rest.messages.entries()][0];
    const { allow } = extractNonces(msg.components);

    const result = pm.handleComponentClick({ customId: `perm:${allow}`, userId: OPERATOR, channelId: 'wrong-thread', messageId: msgId });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'wrong-thread');

    // Clean up the still-pending request so its 5-minute timer doesn't keep
    // the test process alive.
    pm.cancelForThread('thread-1');
    await promise;
  });

  test('replayed click after use is rejected (one-shot enforcement)', async () => {
    const rest = makeFakeRest();
    const pm = new PermissionManager({ restClient: rest, operatorUserId: OPERATOR, logger: silentLogger });
    const promise = pm.requestPermission(baseRequest());
    await new Promise((r) => setTimeout(r, 10));
    const [msgId, msg] = [...rest.messages.entries()][0];
    const { allow } = extractNonces(msg.components);

    pm.handleComponentClick({ customId: `perm:${allow}`, userId: OPERATOR, channelId: 'thread-1', messageId: msgId });
    await promise;
    const replay = pm.handleComponentClick({ customId: `perm:${allow}`, userId: OPERATOR, channelId: 'thread-1', messageId: msgId });
    assert.equal(replay.ok, false);
    assert.ok(['already-used', 'unknown-or-expired'].includes(replay.reason));
  });

  test('unknown/garbage custom_id is rejected without throwing', () => {
    const rest = makeFakeRest();
    const pm = new PermissionManager({ restClient: rest, operatorUserId: OPERATOR, logger: silentLogger });
    const result = pm.handleComponentClick({ customId: 'not-a-perm-id', userId: OPERATOR, channelId: 'thread-1', messageId: 'x' });
    assert.equal(result.ok, false);
  });

  test('timeout resolves with exact cancelled outcome shape', async () => {
    const rest = makeFakeRest();
    let scheduledFn;
    const fakeSetTimeout = (fn, ms) => {
      scheduledFn = fn;
      return { id: 'fake-timer' };
    };
    const fakeClearTimeout = () => {};
    const pm = new PermissionManager({
      restClient: rest,
      operatorUserId: OPERATOR,
      logger: silentLogger,
      setTimeoutImpl: fakeSetTimeout,
      clearTimeoutImpl: fakeClearTimeout,
    });
    const promise = pm.requestPermission(baseRequest());
    await new Promise((r) => setTimeout(r, 10));
    assert.ok(scheduledFn, 'expected a timeout to have been scheduled');
    scheduledFn(); // simulate timeout firing
    const outcome = await promise;
    assert.deepEqual(outcome, { outcome: { outcome: 'cancelled' } });
  });

  test('cancelForThread resolves all pending requests for that thread as cancelled', async () => {
    const rest = makeFakeRest();
    const pm = new PermissionManager({ restClient: rest, operatorUserId: OPERATOR, logger: silentLogger });
    const p1 = pm.requestPermission(baseRequest({ threadId: 'thread-a' }));
    const p2 = pm.requestPermission(baseRequest({ threadId: 'thread-a' }));
    const p3 = pm.requestPermission(baseRequest({ threadId: 'thread-b' }));
    await new Promise((r) => setTimeout(r, 10));

    pm.cancelForThread('thread-a');
    const [o1, o2] = await Promise.all([p1, p2]);
    assert.deepEqual(o1, { outcome: { outcome: 'cancelled' } });
    assert.deepEqual(o2, { outcome: { outcome: 'cancelled' } });

    // thread-b's request should remain pending (not cancelled).
    let settled = false;
    p3.then(() => (settled = true));
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(settled, false);
    pm.cancelForThread('thread-b');
    await p3;
  });

  test('rawInput JSON is bounded in length in the posted message', async () => {
    const rest = makeFakeRest();
    const pm = new PermissionManager({ restClient: rest, operatorUserId: OPERATOR, logger: silentLogger });
    const hugeInput = { data: 'x'.repeat(5000) };
    const promise = pm.requestPermission(baseRequest({ toolCall: { title: 't', kind: 'execute', rawInput: hugeInput } }));
    await new Promise((r) => setTimeout(r, 10));
    const [, msg] = [...rest.messages.entries()][0];
    assert.ok(msg.content.length < 2000);
    assert.match(msg.content, /truncated/);
    pm.cancelForThread('thread-1');
    await promise;
  });

  describe('rawInput secret redaction', () => {
    async function postAndGetContent(pm, rawInput) {
      const promise = pm.requestPermission(baseRequest({ toolCall: { title: 't', kind: 'execute', rawInput } }));
      await new Promise((r) => setTimeout(r, 10));
      const [, msg] = [...pm._rest.messages.entries()].pop();
      pm.cancelForThread('thread-1');
      await promise;
      return msg.content;
    }

    test('deep-redacts values under arbitrary secret-shaped keys, regardless of value type', async () => {
      const rest = makeFakeRest();
      const pm = new PermissionManager({ restClient: rest, operatorUserId: OPERATOR, logger: silentLogger });
      const content = await postAndGetContent(pm, {
        token: 'super-secret-plain-value-not-token-shaped',
        auth_header: 'whatever-arbitrary-value',
        api_key: 12345,
        credential: { nested: 'still-a-secret-object' },
        cookie: ['a', 'b', 'c'],
        PRIVATE_KEY: '-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END-----',
        password: null,
        harmlessField: 'this should remain visible',
      });
      assert.ok(!content.includes('super-secret-plain-value-not-token-shaped'));
      assert.ok(!content.includes('whatever-arbitrary-value'));
      assert.ok(!content.includes('12345'));
      assert.ok(!content.includes('still-a-secret-object'));
      assert.ok(!content.includes('"a",\n        "b",\n        "c"') && !content.includes('"a"'));
      assert.ok(!content.includes('BEGIN RSA PRIVATE KEY'));
      assert.match(content, /harmlessField/);
      assert.match(content, /this should remain visible/);
      assert.match(content, /\[REDACTED\]/);
    });

    test('deep-redacts nested/deeply-buried secret keys inside arrays and objects', async () => {
      const rest = makeFakeRest();
      const pm = new PermissionManager({ restClient: rest, operatorUserId: OPERATOR, logger: silentLogger });
      const content = await postAndGetContent(pm, {
        headers: [{ name: 'X-Custom', secretValue: 'deeply-nested-secret-abc123' }, { name: 'X-Other', value: 'keep-me' }],
      });
      assert.ok(!content.includes('deeply-nested-secret-abc123'));
      assert.match(content, /keep-me/);
    });

    test('still redacts token-shaped values under innocuous key names (value-pattern pass)', async () => {
      const rest = makeFakeRest();
      const pm = new PermissionManager({ restClient: rest, operatorUserId: OPERATOR, logger: silentLogger });
      const content = await postAndGetContent(pm, {
        headerValue: 'Bearer abc123def456ghi789',
        someField: 'ghp_' + 'a'.repeat(36),
      });
      assert.ok(!content.includes('abc123def456ghi789'));
      assert.ok(!content.includes('ghp_' + 'a'.repeat(36)));
      assert.match(content, /\[REDACTED\]/);
    });

    test('final permission Discord content never exceeds 2000 chars even with many secret keys', async () => {
      const rest = makeFakeRest();
      const pm = new PermissionManager({ restClient: rest, operatorUserId: OPERATOR, logger: silentLogger });
      const bigRawInput = {};
      for (let i = 0; i < 50; i++) {
        bigRawInput[`token_${i}`] = 'x'.repeat(100);
      }
      const content = await postAndGetContent(pm, bigRawInput);
      assert.ok(content.length <= 2000, `expected content.length (${content.length}) <= 2000`);
    });
  });
});
