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

const SCRATCH_ROOT = path.join(fileURLToPath(new URL('.', import.meta.url)), '.scratch', 'shutdown');
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

function followUpMessage(threadId, content) {
  return {
    id: `msg-${Math.random().toString(36).slice(2)}`,
    content,
    author: { id: USER_ID, bot: false },
    guild_id: GUILD_ID,
    channel_id: threadId,
    mentions: [],
    mention_roles: [],
    attachments: [],
  };
}

describe('Graceful shutdown', () => {
  test('shutdown() cancels active prompts, closes ACP children, persists state, and closes the gateway', async () => {
    const stateStore = new StateStore(path.join(scratchDir, 'state'), silentLogger);
    await stateStore.load();
    const rest = makeFakeRest();
    const gateway = makeFakeGateway();
    let gatewayClosed = false;
    gateway.close = () => (gatewayClosed = true);

    let resolvePrompt;
    const acpFactory = makeAcpClientFactory([{ promptImpl: () => new Promise((r) => (resolvePrompt = r)) }]);
    const broker = new Broker({
      config: baseConfig(),
      logger: silentLogger,
      restClient: rest,
      gateway,
      stateStore,
      acpClientFactory: acpFactory,
    });
    broker._cachedBotUserId = 'bot-id';

    const messagePromise = broker._onDispatch('MESSAGE_CREATE', {
      id: 'm1',
      content: '<@bot-id> start a long task',
      author: { id: USER_ID, bot: false },
      guild_id: GUILD_ID,
      channel_id: CHANNEL_ID,
      mentions: [{ id: 'bot-id' }],
      mention_roles: [],
      attachments: [],
    });
    await new Promise((r) => setTimeout(r, 50));

    const client = acpFactory.created[0];
    assert.equal(client.closed, false);

    await broker.shutdown();

    assert.deepEqual(client.cancelledSessionIds, ['fake-session-id']);
    assert.equal(client.closed, true, 'expected the ACP child to be closed on shutdown');
    assert.equal(gatewayClosed, true, 'expected the gateway connection to be closed on shutdown');

    // State should have been persisted: reloading from disk shows the thread.
    const reloaded = new StateStore(path.join(scratchDir, 'state'), silentLogger);
    const data = await reloaded.load();
    assert.equal(Object.keys(data.threads).length, 1);

    resolvePrompt({ stopReason: 'cancelled' });
    await messagePromise.catch(() => {});
  });

  test('after shutdown, dispatched events are ignored (stops accepting events)', async () => {
    const stateStore = new StateStore(path.join(scratchDir, 'state'), silentLogger);
    await stateStore.load();
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
    broker._cachedBotUserId = 'bot-id';

    await broker.shutdown();
    await broker._onDispatch('MESSAGE_CREATE', {
      id: 'm1',
      content: '<@bot-id> hello',
      author: { id: USER_ID, bot: false },
      guild_id: GUILD_ID,
      channel_id: CHANNEL_ID,
      mentions: [{ id: 'bot-id' }],
      mention_roles: [],
      attachments: [],
    });
    assert.equal(rest.createdThreads.length, 0, 'no new threads should be created after shutdown');
  });
});

describe('Session restore on restart', () => {
  test('successful resume: a follow-up message after "restart" resumes the stored Copilot session', async () => {
    const stateStore = new StateStore(path.join(scratchDir, 'state'), silentLogger);
    await stateStore.load();
    stateStore.setThread('thread-1', {
      copilotSessionId: 'persisted-session-id',
      cwd: '/home/sachin',
      createdAt: 'x',
      updatedAt: 'y',
    });
    await stateStore.save();

    const rest = makeFakeRest();
    const gateway = makeFakeGateway();
    const acpFactory = makeAcpClientFactory(); // default: sessionResume resolves fine
    const broker = new Broker({
      config: baseConfig(),
      logger: silentLogger,
      restClient: rest,
      gateway,
      stateStore,
      acpClientFactory: acpFactory,
    });

    await broker._onDispatch('MESSAGE_CREATE', followUpMessage('thread-1', 'continue where we left off'));

    assert.equal(acpFactory.created.length, 1);
    // No "could not restore" warning message should have been posted.
    const warnings = rest.channelMessages.filter((m) => /Could not restore/.test(m.body.content || ''));
    assert.equal(warnings.length, 0);
  });

  test('failed resume: reports the failure explicitly and does NOT silently start a new session', async () => {
    const stateStore = new StateStore(path.join(scratchDir, 'state'), silentLogger);
    await stateStore.load();
    stateStore.setThread('thread-1', {
      copilotSessionId: 'persisted-session-id',
      cwd: '/home/sachin',
      createdAt: 'x',
      updatedAt: 'y',
    });
    await stateStore.save();

    const rest = makeFakeRest();
    const gateway = makeFakeGateway();
    const acpFactory = makeAcpClientFactory([{ resumeError: new Error('agent restart lost session') }]);
    const broker = new Broker({
      config: baseConfig(),
      logger: silentLogger,
      restClient: rest,
      gateway,
      stateStore,
      acpClientFactory: acpFactory,
    });

    await broker._onDispatch('MESSAGE_CREATE', followUpMessage('thread-1', 'continue where we left off'));

    // A prompt must NOT have been sent to a freshly (silently) created session.
    const client = acpFactory.created[0];
    assert.equal(client.lastPromptBlocks, undefined, 'no prompt should be sent when resume fails');

    const warning = rest.channelMessages.find((m) => /Could not restore/.test(m.body.content || ''));
    assert.ok(warning, 'expected an explicit failure message directing the user to /reset');
    assert.match(warning.body.content, /\/reset/);

    // The persisted mapping must remain untouched (still points at the old, now-unresumable session)
    // so no context was silently discarded either.
    assert.equal(stateStore.getThread('thread-1').copilotSessionId, 'persisted-session-id');

    // A subsequent message still fails the same way (no silent fallback appears over time).
    await broker._onDispatch('MESSAGE_CREATE', followUpMessage('thread-1', 'try again'));
    assert.equal(acpFactory.created.length, 2);
    assert.equal(acpFactory.created[1].lastPromptBlocks, undefined);
  });
});
