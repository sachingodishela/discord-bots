import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { rm, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Broker } from '../src/broker.js';
import { StateStore } from '../src/state/store.js';
import { createLogger } from '../src/logger.js';
import { makeFakeRest, makeFakeGateway, makeAcpClientFactory, FakeAcpClient } from './helpers/fakes.js';

const GUILD_ID = '1534099914391556228';
const CHANNEL_ID = '1534100366373818428';
const USER_ID = '710119698313773178';
const ROLE_ID = '1534099998214717453';

const SCRATCH_ROOT = path.join(fileURLToPath(new URL('.', import.meta.url)), '.scratch', 'broker-lifecycle');
const silentLogger = createLogger({ logLevel: 'error' }, { write: () => {} });

function baseConfig(overrides = {}) {
  return {
    discordGuildId: GUILD_ID,
    discordChannelId: CHANNEL_ID,
    discordUserId: USER_ID,
    discordRoleId: ROLE_ID,
    defaultCwd: '/home/sachin',
    copilotBin: '/unused/copilot',
    maxSessions: 3,
    attachmentMaxBytes: 1024 * 1024,
    attachmentMaxCount: 5,
    ...overrides,
  };
}

let scratchDir;
beforeEach(async () => {
  scratchDir = path.join(SCRATCH_ROOT, `run-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(scratchDir, { recursive: true });
});
afterEach(async () => {
  await rm(scratchDir, { recursive: true, force: true });
});

function imageAttachment() {
  return {
    id: 'att-1',
    filename: 'photo.png',
    content_type: 'image/png',
    size: 10,
    url: 'https://cdn.discordapp.com/attachments/1/2/photo.png',
  };
}

/** A minimal fetch stub that serves a small binary body for any URL requested. */
function makeImageFetch() {
  const bytes = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  return async () => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    body: {
      getReader() {
        let done = false;
        return {
          async read() {
            if (done) return { done: true, value: undefined };
            done = true;
            return { done: false, value: new Uint8Array(bytes) };
          },
          async cancel() {},
        };
      },
    },
  });
}

async function makeBroker({ scratch, acpBehaviors } = {}) {
  const stateStore = new StateStore(path.join(scratch, 'state'), silentLogger);
  await stateStore.load();
  const rest = makeFakeRest();
  const gateway = makeFakeGateway();
  const acpFactory = makeAcpClientFactory(acpBehaviors || []);
  const broker = new Broker({
    config: baseConfig(),
    logger: silentLogger,
    restClient: rest,
    gateway,
    stateStore,
    acpClientFactory: acpFactory,
    fetchImpl: makeImageFetch(),
  });
  broker._cachedBotUserId = 'bot-id';
  return { broker, rest, gateway, stateStore, acpFactory };
}

function mentionMessage(content, attachments = []) {
  return {
    id: 'm1',
    content: `<@bot-id> ${content}`,
    author: { id: USER_ID, bot: false },
    guild_id: GUILD_ID,
    channel_id: CHANNEL_ID,
    mentions: [{ id: 'bot-id' }],
    mention_roles: [],
    attachments,
  };
}

describe('Broker attachments use the real ACP image capability (item 5)', () => {
  test('when the ACP client advertises image support, an image attachment becomes an image content block (not rejected)', async () => {
    const { broker, rest, acpFactory } = await makeBroker({ scratch: scratchDir, acpBehaviors: [{ imagesSupported: true }] });

    await broker._onDispatch('MESSAGE_CREATE', mentionMessage('look at this', [imageAttachment()]));

    const client = acpFactory.created[0];
    assert.ok(client.lastPromptBlocks, 'expected a prompt to have been sent');
    const imageBlocks = client.lastPromptBlocks.filter((b) => b.type === 'image');
    assert.equal(imageBlocks.length, 1, 'expected the image attachment to be included as an image block');

    const rejectionNotices = rest.channelMessages.filter((m) => /not included/.test(m.body.content || ''));
    assert.equal(rejectionNotices.length, 0, 'the image must not have been rejected');
  });

  test('when the ACP client does NOT advertise image support, an image attachment is rejected (not hardcoded to always-false in a way that silently drops it)', async () => {
    const { broker, rest, acpFactory } = await makeBroker({ scratch: scratchDir, acpBehaviors: [{ imagesSupported: false }] });

    await broker._onDispatch('MESSAGE_CREATE', mentionMessage('look at this', [imageAttachment()]));

    const client = acpFactory.created[0];
    const imageBlocks = (client.lastPromptBlocks || []).filter((b) => b.type === 'image');
    assert.equal(imageBlocks.length, 0, 'no image block should be sent to an agent that does not support images');

    const rejectionNotice = rest.channelMessages.find((m) => /not included/.test(m.body.content || ''));
    assert.ok(rejectionNotice, 'expected an explicit rejection notice explaining the image was not included');
    assert.match(rejectionNotice.body.content, /does not support image/);
  });
});

describe('Expected ACP shutdown/reset races (item 6)', () => {
  test('a child exit that happens as a direct result of /reset is expected and does NOT post an "exited unexpectedly" warning', async () => {
    const { broker, rest, acpFactory } = await makeBroker({ scratch: scratchDir });

    await broker._onDispatch('MESSAGE_CREATE', mentionMessage('start a session'));
    const threadId = rest.createdThreads[0].id;
    const client = acpFactory.created[0];
    assert.equal(client.closed, false);

    // Simulate /reset's teardown calling close(), followed (possibly async,
    // as with a real child process) by the child's 'exit' event firing.
    await broker._resetThread(threadId);
    assert.equal(client.closed, true);
    client.emit('exit', 0, null);
    await new Promise((r) => setTimeout(r, 20));

    const unexpectedWarning = rest.channelMessages.find((m) => /exited unexpectedly/.test(m.body.content || ''));
    assert.equal(unexpectedWarning, undefined, 'an expected close must never post the "unexpectedly" warning');
  });

  test('a stale/delayed exit from a torn-down session does not delete or affect its replacement session', async () => {
    const { broker, rest, acpFactory } = await makeBroker({ scratch: scratchDir });

    // Start the first session for this thread.
    await broker._onDispatch('MESSAGE_CREATE', mentionMessage('start a session'));
    const threadId = rest.createdThreads[0].id;
    const firstClient = acpFactory.created[0];

    // Simulate an external teardown+replace race: the broker tears the first
    // session down (e.g. via reset) and immediately registers a second,
    // genuinely distinct session (its own ACP child) for the very same
    // thread before the first child's delayed 'exit' event is observed.
    broker._teardownSession(threadId);
    const secondClient = new FakeAcpClient({ cwd: '/home/sachin' });
    const secondSession = broker._registerSession(threadId, secondClient, '/home/sachin');
    // Give the replacement a distinguishing marker we can check survives.
    secondSession.copilotSessionId = 'replacement-session-id';

    // Now the *first* (already torn-down) client's exit event finally fires.
    firstClient.emit('exit', 1, null);
    await new Promise((r) => setTimeout(r, 20));

    // The replacement session must still be the live one for this thread,
    // untouched by the stale exit.
    assert.equal(broker._sessions.get(threadId), secondSession);
    assert.equal(broker._sessions.get(threadId).copilotSessionId, 'replacement-session-id');

    const unexpectedWarning = rest.channelMessages.find((m) => /exited unexpectedly/.test(m.body.content || ''));
    assert.equal(unexpectedWarning, undefined, 'a stale exit from a replaced session must not post any warning');
  });

  test('an unexpected exit of the CURRENT live session (not a teardown) still posts the warning and clears the session', async () => {
    const { broker, rest, acpFactory } = await makeBroker({ scratch: scratchDir });

    await broker._onDispatch('MESSAGE_CREATE', mentionMessage('start a session'));
    const threadId = rest.createdThreads[0].id;
    const client = acpFactory.created[0];

    // No teardown here: the child just crashes on its own.
    client.emit('exit', 1, null);
    await new Promise((r) => setTimeout(r, 20));

    assert.equal(broker._sessions.has(threadId), false, 'the crashed session must be removed');
    const warning = rest.channelMessages.find((m) => /exited unexpectedly/.test(m.body.content || ''));
    assert.ok(warning, 'a genuinely unexpected exit must still be reported');
  });
});
