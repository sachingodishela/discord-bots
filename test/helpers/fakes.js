import { EventEmitter } from 'node:events';

/** Generates plausible Discord-snowflake-shaped ids (17-20 digit decimal strings). */
let _snowflakeCounter = 100000000000000000n;
function nextSnowflake() {
  _snowflakeCounter += 1n;
  return _snowflakeCounter.toString();
}

/** In-memory fake Discord REST client sufficient for Broker integration tests. */
export function makeFakeRest() {
  const channelMessages = []; // {channelId, body}
  const editedMessages = [];
  const createdThreads = [];
  const editedInteractionResponses = [];
  return {
    channelMessages,
    editedMessages,
    createdThreads,
    editedInteractionResponses,
    async createMessage(channelId, body) {
      const id = nextSnowflake();
      channelMessages.push({ id, channelId, body });
      return { id, channel_id: channelId };
    },
    async createThreadMessage(threadId, body) {
      return this.createMessage(threadId, body);
    },
    async editMessage(channelId, messageId, body) {
      editedMessages.push({ channelId, messageId, body });
      return { id: messageId };
    },
    async startThreadFromMessage(channelId, messageId, body) {
      const id = nextSnowflake();
      createdThreads.push({ id, channelId, messageId, body });
      return { id, parent_id: channelId };
    },
    async putGuildApplicationCommands() {
      return [];
    },
    async createInteractionResponse(interactionId, token, body) {
      this.lastInteractionResponse = { interactionId, body };
      this.interactionResponses ||= [];
      this.interactionResponses.push({ interactionId, body });
      return null;
    },
    async editOriginalInteractionResponse(applicationId, token, body) {
      editedInteractionResponses.push({ applicationId, body });
      this.lastEditedInteractionResponse = { applicationId, body };
      return null;
    },
  };
}

/** Fake gateway: just an EventEmitter with the methods Broker calls directly. */
export function makeFakeGateway() {
  const emitter = new EventEmitter();
  emitter.loadResumeState = () => {};
  emitter.connect = () => {};
  emitter.close = () => {};
  return emitter;
}

/** Fake ACP client mimicking the subset of AcpClient's surface Broker uses. */
export class FakeAcpClient extends EventEmitter {
  /** @param {object} opts @param {object} [behavior] */
  constructor(opts, behavior = {}) {
    super();
    this.opts = opts;
    this.behavior = behavior;
    this.closed = false;
    this.cancelledSessionIds = [];
    this.sessionClosed = false;
  }

  async initialize() {
    if (this.behavior.initializeError) throw this.behavior.initializeError;
    return { agentCapabilities: {} };
  }

  /** @returns {boolean} mirrors AcpClient.supportsImages() for Broker tests */
  supportsImages() {
    return !!this.behavior.imagesSupported;
  }

  async sessionNew(cwd) {
    if (this.behavior.sessionNewError) throw this.behavior.sessionNewError;
    return this.behavior.sessionId || 'fake-session-id';
  }

  async sessionResume(sessionId, cwd) {
    if (this.behavior.resumeError) throw this.behavior.resumeError;
    return { method: 'resume', result: {} };
  }

  sessionPrompt(sessionId, blocks) {
    this.lastPromptBlocks = blocks;
    if (this.behavior.promptImpl) return this.behavior.promptImpl(sessionId, blocks, this);
    if (this.behavior.promptError) return Promise.reject(this.behavior.promptError);
    return Promise.resolve({ stopReason: 'end_turn' });
  }

  sessionCancel(sessionId) {
    this.cancelledSessionIds.push(sessionId);
  }

  async sessionClose(sessionId) {
    this.sessionClosed = true;
    return {};
  }

  close() {
    this.closed = true;
  }
}

/**
 * Builds an acpClientFactory for Broker that hands out FakeAcpClient
 * instances, optionally with per-call behavior overrides (in call order).
 * @param {object[]} behaviors
 */
export function makeAcpClientFactory(behaviors = []) {
  let idx = 0;
  const created = [];
  const factory = (opts) => {
    const behavior = behaviors[idx] || behaviors[behaviors.length - 1] || {};
    idx += 1;
    const client = new FakeAcpClient(opts, behavior);
    created.push(client);
    return client;
  };
  factory.created = created;
  return factory;
}
