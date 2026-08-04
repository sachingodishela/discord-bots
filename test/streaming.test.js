import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { StreamingReply, DISCORD_MESSAGE_LIMIT } from '../src/discord/streaming.js';
import { createLogger } from '../src/logger.js';

const silentLogger = createLogger({ logLevel: 'error' }, { write: () => {} });

/** Fake REST client + fake clock for deterministic edit-throttle testing. */
function makeFakeRest() {
  let nextId = 1;
  const created = [];
  const edits = [];
  return {
    created,
    edits,
    async createThreadMessage(threadId, body) {
      const id = `m${nextId++}`;
      created.push({ id, threadId, content: body.content });
      return { id };
    },
    async editMessage(threadId, messageId, body) {
      edits.push({ threadId, messageId, content: body.content });
      return { id: messageId };
    },
  };
}

/** Manual fake timer: captures the interval callback and lets tests tick it. */
function makeFakeTimer() {
  let cb = null;
  return {
    setIntervalImpl: (fn) => {
      cb = fn;
      return { id: 'fake-interval' };
    },
    clearIntervalImpl: () => {
      cb = null;
    },
    tick: async () => {
      if (cb) await cb();
    },
  };
}

describe('StreamingReply', () => {
  test('creates a placeholder message on start()', async () => {
    const rest = makeFakeRest();
    const timer = makeFakeTimer();
    const reply = new StreamingReply({ restClient: rest, threadId: 't1', logger: silentLogger, ...timer });
    await reply.start();
    assert.equal(rest.created.length, 1);
    assert.equal(rest.created[0].threadId, 't1');
  });

  test('edits are throttled: only applied when the timer ticks, at most once per tick', async () => {
    const rest = makeFakeRest();
    const timer = makeFakeTimer();
    const reply = new StreamingReply({ restClient: rest, threadId: 't1', logger: silentLogger, ...timer });
    await reply.start();

    reply.appendText('hello ');
    reply.appendText('world');
    // No edit yet: tick hasn't fired.
    assert.equal(rest.edits.length, 0);

    await timer.tick();
    assert.equal(rest.edits.length, 1);
    assert.equal(rest.edits[0].content, 'hello world');

    // A second tick with no new content should not produce another edit.
    await timer.tick();
    assert.equal(rest.edits.length, 1);

    reply.appendText('!');
    await timer.tick();
    assert.equal(rest.edits.length, 2);
    assert.equal(rest.edits[1].content, 'hello world!');
  });

  test('splits content across sequential messages when exceeding the 2000-char limit', async () => {
    const rest = makeFakeRest();
    const timer = makeFakeTimer();
    const reply = new StreamingReply({ restClient: rest, threadId: 't1', logger: silentLogger, ...timer });
    await reply.start();

    const chunk = 'a'.repeat(1200) + '\n';
    reply.appendText(chunk);
    reply.appendText(chunk);
    await timer.tick();

    // Should have created at least one additional message beyond the placeholder.
    assert.ok(rest.created.length >= 2, `expected split into multiple messages, got ${rest.created.length}`);
    for (const m of rest.created) {
      assert.ok(m.content.length <= DISCORD_MESSAGE_LIMIT);
    }
    for (const e of rest.edits) {
      assert.ok(e.content.length <= DISCORD_MESSAGE_LIMIT);
    }

    // No content lost: concatenation of all message content should contain both chunks fully.
    const allText = [...rest.created.map((m) => m.content), ...rest.edits.map((e) => e.content)].join('');
    assert.ok(allText.includes('a'.repeat(1200)));
  });

  test('finalize() flushes pending content immediately without waiting for a tick', async () => {
    const rest = makeFakeRest();
    const timer = makeFakeTimer();
    const reply = new StreamingReply({ restClient: rest, threadId: 't1', logger: silentLogger, ...timer });
    await reply.start();
    reply.appendText('final answer');
    await reply.finalize();
    assert.equal(rest.edits.length, 1);
    assert.equal(rest.edits[0].content, 'final answer');
  });

  test('finalize() with no content shows a placeholder "(no response)" message', async () => {
    const rest = makeFakeRest();
    const timer = makeFakeTimer();
    const reply = new StreamingReply({ restClient: rest, threadId: 't1', logger: silentLogger, ...timer });
    await reply.start();
    await reply.finalize();
    assert.match(rest.edits[0].content, /no response/);
  });

  test('fail() appends an error indicator and finalizes', async () => {
    const rest = makeFakeRest();
    const timer = makeFakeTimer();
    const reply = new StreamingReply({ restClient: rest, threadId: 't1', logger: silentLogger, ...timer });
    await reply.start();
    reply.appendText('partial');
    await reply.fail('something broke');
    assert.match(rest.edits[0].content, /partial/);
    assert.match(rest.edits[0].content, /something broke/);
  });

  test('concurrent StreamingReply instances for different threads do not interfere', async () => {
    const rest = makeFakeRest();
    const timerA = makeFakeTimer();
    const timerB = makeFakeTimer();
    const replyA = new StreamingReply({ restClient: rest, threadId: 'thread-a', logger: silentLogger, ...timerA });
    const replyB = new StreamingReply({ restClient: rest, threadId: 'thread-b', logger: silentLogger, ...timerB });
    await Promise.all([replyA.start(), replyB.start()]);

    replyA.appendText('A-text');
    replyB.appendText('B-text');
    await Promise.all([timerA.tick(), timerB.tick()]);

    const aEdits = rest.edits.filter((e) => e.threadId === 'thread-a');
    const bEdits = rest.edits.filter((e) => e.threadId === 'thread-b');
    assert.equal(aEdits.length, 1);
    assert.equal(bEdits.length, 1);
    assert.equal(aEdits[0].content, 'A-text');
    assert.equal(bEdits[0].content, 'B-text');
  });
});
