import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { rm, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Broker } from '../src/broker.js';
import { StateStore } from '../src/state/store.js';
import { createLogger } from '../src/logger.js';
import { makeFakeRest, makeFakeGateway, makeAcpClientFactory } from './helpers/fakes.js';

const GUILD_ID = '1534099914391556228';
const CHANNEL_ID = '1534100366373818428';
const USER_ID = '710119698313773178';
const ROLE_ID = '1534099998214717453';
const OTHER_USER = '999999999999999999';

const SCRATCH_ROOT = path.join(fileURLToPath(new URL('.', import.meta.url)), '.scratch', 'commands');

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
    attachmentMaxBytes: 1024,
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

async function makeBroker(overrides = {}) {
  const stateStore = new StateStore(path.join(scratchDir, 'state'), silentLogger);
  await stateStore.load();
  const rest = makeFakeRest();
  const gateway = makeFakeGateway();
  const acpFactory = makeAcpClientFactory(overrides.behaviors);
  const broker = new Broker({
    config: baseConfig(overrides.config),
    logger: silentLogger,
    restClient: rest,
    gateway,
    stateStore,
    acpClientFactory: acpFactory,
  });
  return { broker, rest, gateway, stateStore, acpFactory };
}

function makeInteraction({ name, threadId = CHANNEL_ID, userId = USER_ID, guildId = GUILD_ID }) {
  return {
    id: `interaction-${Math.random().toString(36).slice(2)}`,
    token: 'fake-interaction-token',
    type: 2,
    guild_id: guildId,
    channel_id: threadId,
    member: { user: { id: userId } },
    data: { name },
  };
}

describe('Slash command authorization and behavior', () => {
  test('/status in an unknown thread reports not-known without error', async () => {
    const { broker, rest } = await makeBroker();
    await broker._onDispatch('INTERACTION_CREATE', makeInteraction({ name: 'status', threadId: 'unknown-thread' }));
    // wrong-channel -> not authorized (unknown thread channel isn't the configured channel either)
    const response = rest.lastInteractionResponse.body;
    assert.match(response.data.content, /Not authorized/);
  });

  test('/status in the configured top-level channel succeeds (even with no active thread)', async () => {
    const { broker, rest } = await makeBroker();
    await broker._onDispatch('INTERACTION_CREATE', makeInteraction({ name: 'status', threadId: CHANNEL_ID }));
    const response = rest.lastInteractionResponse.body;
    assert.match(response.data.content, /not a known Copilot session thread/);
  });

  test('rejects commands from the wrong user with an ephemeral "Not authorized" response', async () => {
    const { broker, rest } = await makeBroker();
    await broker._onDispatch('INTERACTION_CREATE', makeInteraction({ name: 'status', userId: OTHER_USER }));
    const response = rest.lastInteractionResponse.body;
    assert.match(response.data.content, /Not authorized/);
    assert.equal(response.data.flags, 1 << 6); // ephemeral
  });

  test('rejects commands from the wrong guild', async () => {
    const { broker, rest } = await makeBroker();
    await broker._onDispatch('INTERACTION_CREATE', makeInteraction({ name: 'status', guildId: '1111111111111111' }));
    const response = rest.lastInteractionResponse.body;
    assert.match(response.data.content, /Not authorized/);
  });

  test('/status on a known thread with an active session reports cwd, state, and shortened session id (no secrets)', async () => {
    const stateStore = new StateStore(path.join(scratchDir, 'state'), silentLogger);
    await stateStore.load();
    stateStore.setThread('thread-1', {
      copilotSessionId: 'sess-abcdef123456',
      cwd: '/home/sachin/project',
      createdAt: 'x',
      updatedAt: 'y',
    });
    await stateStore.save();

    const rest = makeFakeRest();
    const gateway = makeFakeGateway();
    const broker = new Broker({
      config: baseConfig(),
      logger: silentLogger,
      restClient: rest,
      gateway,
      stateStore,
      acpClientFactory: makeAcpClientFactory(),
    });

    await broker._onDispatch('INTERACTION_CREATE', makeInteraction({ name: 'status', threadId: 'thread-1' }));
    const response = rest.lastInteractionResponse.body;
    assert.match(response.data.content, /sess-abc/);
    assert.match(response.data.content, /home\/sachin\/project/);
    assert.doesNotMatch(response.data.content, /discordBotToken|Bot /);
  });

  test('/cancel sends session/cancel to the active ACP client and cancels pending approvals', async () => {
    let resolvePrompt;
    const { broker, rest, acpFactory } = await makeBroker({
      behaviors: [{ promptImpl: () => new Promise((r) => (resolvePrompt = r)) }],
    });
    broker._cachedBotUserId = 'bot-id';

    // Fire-and-await-later: this dispatch's prompt turn intentionally never
    // resolves until we call resolvePrompt() below, so don't await it yet.
    const messagePromise = broker._onDispatch('MESSAGE_CREATE', {
      id: 'm1',
      content: `<@bot-id> do something slow`,
      author: { id: USER_ID, bot: false },
      guild_id: GUILD_ID,
      channel_id: CHANNEL_ID,
      mentions: [{ id: 'bot-id' }],
      mention_roles: [],
      attachments: [],
    });

    // Let the thread-creation + session-start microtasks run before the
    // (still-pending) prompt call blocks further progress.
    await new Promise((r) => setTimeout(r, 50));

    assert.equal(rest.createdThreads.length, 1);
    const threadId = rest.createdThreads[0].id;

    await broker._onDispatch('INTERACTION_CREATE', makeInteraction({ name: 'cancel', threadId }));
    const client = acpFactory.created.at(-1);
    assert.deepEqual(client.cancelledSessionIds, ['fake-session-id']);
    const response = rest.lastInteractionResponse.body;
    assert.match(response.data.content, /Cancelled/);
    resolvePrompt({ stopReason: 'cancelled' });
    await messagePromise;
  });

  test('/reset ACKs immediately (deferred) then closes the session and clears the mapping via an edited response', async () => {
    const { broker, rest, stateStore, acpFactory } = await makeBroker();
    broker._cachedBotUserId = 'bot-id';
    broker._applicationId = 'app-id';
    await broker._onDispatch('MESSAGE_CREATE', {
      id: 'm1',
      content: `<@bot-id> hello`,
      author: { id: USER_ID, bot: false },
      guild_id: GUILD_ID,
      channel_id: CHANNEL_ID,
      mentions: [{ id: 'bot-id' }],
      mention_roles: [],
      attachments: [],
    });
    const threadId = rest.createdThreads[0].id;
    assert.equal(stateStore.getThread(threadId).copilotSessionId, 'fake-session-id');

    await broker._onDispatch('INTERACTION_CREATE', makeInteraction({ name: 'reset', threadId }));

    const firstClient = acpFactory.created[0];
    assert.equal(firstClient.sessionClosed, true);
    assert.equal(firstClient.closed, true);
    assert.equal(stateStore.getThread(threadId).copilotSessionId, null);

    // The immediate callback is a deferred ACK (type 5), not the final text.
    const immediate = rest.lastInteractionResponse.body;
    assert.equal(immediate.type, 5);
    assert.equal(immediate.data.content, undefined);

    // The user-visible confirmation is delivered via an edit of the original response.
    assert.equal(rest.editedInteractionResponses.length, 1);
    assert.match(rest.editedInteractionResponses[0].body.content, /reset/i);

    // Thread remains known: a follow-up message (no mention needed) should start a fresh session.
    await broker._onDispatch('MESSAGE_CREATE', {
      id: 'm2',
      content: 'continue please',
      author: { id: USER_ID, bot: false },
      guild_id: GUILD_ID,
      channel_id: threadId,
      mentions: [],
      mention_roles: [],
      attachments: [],
    });
    assert.equal(acpFactory.created.length, 2, 'expected a fresh ACP client to be spawned');
    assert.equal(stateStore.getThread(threadId).copilotSessionId, 'fake-session-id');
  });

  test('/reset ACK is sent before the (slow) session close resolves, so the interaction never risks Discord\'s 3s deadline', async () => {
    let releaseClose;
    const closeGate = new Promise((r) => (releaseClose = r));
    const { broker, rest, acpFactory } = await makeBroker();
    broker._cachedBotUserId = 'bot-id';
    broker._applicationId = 'app-id';
    await broker._onDispatch('MESSAGE_CREATE', {
      id: 'm1',
      content: `<@bot-id> hello`,
      author: { id: USER_ID, bot: false },
      guild_id: GUILD_ID,
      channel_id: CHANNEL_ID,
      mentions: [{ id: 'bot-id' }],
      mention_roles: [],
      attachments: [],
    });
    const threadId = rest.createdThreads[0].id;
    const client = acpFactory.created[0];
    // Make session/close artificially slow (would blow well past 3s in prod).
    client.sessionClose = async () => {
      await closeGate;
      client.sessionClosed = true;
      return {};
    };

    const order = [];
    const originalCreateResponse = rest.createInteractionResponse.bind(rest);
    rest.createInteractionResponse = async (...args) => {
      order.push('ack');
      return originalCreateResponse(...args);
    };
    const originalEdit = rest.editOriginalInteractionResponse.bind(rest);
    rest.editOriginalInteractionResponse = async (...args) => {
      order.push('edit');
      return originalEdit(...args);
    };

    const resetPromise = broker._onDispatch('INTERACTION_CREATE', makeInteraction({ name: 'reset', threadId }));
    // Let the ACK (and everything up to the slow session/close call) run.
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(order, ['ack'], 'the ACK must be sent before the slow close resolves');

    releaseClose();
    await resetPromise;
    assert.deepEqual(order, ['ack', 'edit']);
  });
});
