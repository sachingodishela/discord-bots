/**
 * Broker: orchestrates Discord Gateway events, thread/session lifecycle,
 * ACP client processes, streaming replies, attachments, and permissions.
 *
 * One Discord thread maps to exactly one Copilot ACP session/process.
 * Thread sessions share the host filesystem (same Linux user) but have
 * independent Copilot session ids and child processes.
 */
import { AcpClient, AcpChildExitError, AcpProtocolError } from './acp/client.js';
import { PermissionManager } from './acp/permissions.js';
import { StreamingReply } from './discord/streaming.js';
import { processAttachments } from './discord/attachments.js';
import { admitMessage, evaluateTopLevelTrigger } from './discord/mentions.js';
import {
  COMMAND_DEFINITIONS,
  INTERACTION_TYPE,
  validateInteraction,
  ephemeralResponse,
  deferredEphemeralResponse,
} from './discord/commands.js';

const MAX_PROMPT_TEXT_CHARS = 4000; // sanity bound on incoming prompt text

export class Broker {
  /**
   * @param {{
   *   config: object,
   *   logger: import('./logger.js').Logger,
   *   restClient: import('./discord/rest.js').DiscordRestClient,
   *   gateway: import('./discord/gateway.js').GatewayClient,
   *   stateStore: import('./state/store.js').StateStore,
   *   fetchImpl?: typeof fetch,
   *   acpClientFactory?: (opts:object) => AcpClient,
   * }} deps
   */
  constructor(deps) {
    this.config = deps.config;
    this.logger = deps.logger.child({ component: 'broker' });
    this.rest = deps.restClient;
    this.gateway = deps.gateway;
    this.state = deps.stateStore;
    this._fetch = deps.fetchImpl || fetch;
    this._acpClientFactory = deps.acpClientFactory || ((opts) => new AcpClient(opts).start());

    this.permissions = new PermissionManager({
      restClient: this.rest,
      operatorUserId: this.config.discordUserId,
      logger: this.logger,
    });

    /** @type {Map<string, ThreadSession>} threadId -> live session */
    this._sessions = new Map();
    this._applicationId = null;
    this._shuttingDown = false;

    this.gateway.on('dispatch', (t, d) => this._onDispatch(t, d).catch((err) => {
      this.logger.error('dispatch handler failed', { type: t, error: err.message });
    }));
  }

  async start() {
    const gatewayState = this.state.getGateway();
    this.gateway.loadResumeState(gatewayState);
    this.gateway.connect();
  }

  /** @private */
  async _onDispatch(type, data) {
    if (this._shuttingDown) return;
    switch (type) {
      case 'READY':
        this._applicationId = data.application?.id;
        this._cachedBotUserId = data.user?.id || this._cachedBotUserId;
        await this._registerCommands();
        break;
      case 'MESSAGE_CREATE':
        await this._onMessageCreate(data);
        break;
      case 'INTERACTION_CREATE':
        await this._onInteractionCreate(data);
        break;
      default:
        break;
    }
  }

  /** @private */
  async _registerCommands() {
    if (!this._applicationId) return;
    try {
      await this.rest.putGuildApplicationCommands(
        this._applicationId,
        this.config.discordGuildId,
        COMMAND_DEFINITIONS,
      );
      this.logger.info('registered guild commands', { count: COMMAND_DEFINITIONS.length });
    } catch (err) {
      this.logger.error('failed to register guild commands', { error: err.message });
    }
  }

  // --- Message handling -----------------------------------------------------

  /** @private @param {object} message */
  async _onMessageCreate(message) {
    const admission = admitMessage(
      message,
      {
        guildId: this.config.discordGuildId,
        channelId: this.config.discordChannelId,
        userId: this.config.discordUserId,
        botUserId: this._botUserId(),
      },
      { isKnownThread: (id) => this._isKnownThread(id) },
    );
    if (!admission.admitted) {
      this.logger.debug('message not admitted', { reason: admission.reason });
      return;
    }

    if (admission.isThreadFollowUp) {
      await this._handleThreadFollowUp(message);
      return;
    }

    const trigger = evaluateTopLevelTrigger(message, {
      botUserId: this._botUserId(),
      roleId: this.config.discordRoleId,
    });
    if (!trigger.trigger) return;

    await this._handleNewThreadRequest(message, trigger.prompt);
  }

  /** @private @returns {string} bot's own user id, learned from READY */
  _botUserId() {
    return this._cachedBotUserId || '';
  }

  /** @private @param {string} threadId */
  _isKnownThread(threadId) {
    return !!this.state.getThread(threadId);
  }

  /** @private @param {object} message @param {string} prompt */
  async _handleNewThreadRequest(message, prompt) {
    if (this._activeSessionCount() >= this.config.maxSessions) {
      await this.rest.createMessage(message.channel_id, {
        content: `⚠️ Maximum concurrent sessions (${this.config.maxSessions}) reached. Try again once an existing thread finishes.`,
        message_reference: { message_id: message.id },
      });
      return;
    }

    let thread;
    try {
      thread = await this.rest.startThreadFromMessage(message.channel_id, message.id, {
        name: truncate(prompt || 'Copilot session', 90),
        auto_archive_duration: 1440,
      });
    } catch (err) {
      this.logger.error('failed to create thread', { error: err.message });
      return;
    }

    this.state.setThread(thread.id, {
      copilotSessionId: null,
      cwd: this.config.defaultCwd,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    await this._saveState();

    await this._startNewSession(thread.id, this.config.defaultCwd, prompt, message.attachments || []);
  }

  /** @private @param {object} message */
  async _handleThreadFollowUp(message) {
    const threadId = message.channel_id;
    const existing = this._sessions.get(threadId);
    if (existing?.busy) {
      await this.rest.createThreadMessage(threadId, {
        content: '⏳ Still processing the previous request. Use `/cancel` to interrupt it first.',
      });
      return;
    }

    if (existing) {
      await this._sendPrompt(existing, message.content || '', message.attachments || []);
      return;
    }

    // No in-memory session: either fresh after /reset, or needs lazy restore.
    const persisted = this.state.getThread(threadId);
    if (!persisted) return; // shouldn't happen, isKnownThread already checked

    if (this._activeSessionCount() >= this.config.maxSessions) {
      await this.rest.createThreadMessage(threadId, {
        content: `⚠️ Maximum concurrent sessions (${this.config.maxSessions}) reached. Try again later.`,
      });
      return;
    }

    if (persisted.copilotSessionId) {
      await this._restoreSession(threadId, persisted, message.content || '', message.attachments || []);
    } else {
      await this._startNewSession(threadId, persisted.cwd, message.content || '', message.attachments || []);
    }
  }

  /** @private @returns {number} */
  _activeSessionCount() {
    return this._sessions.size;
  }

  /**
   * @private
   * @param {string} threadId @param {string} cwd @param {string} promptText @param {object[]} attachments
   */
  async _startNewSession(threadId, cwd, promptText, attachments) {
    const acp = this._acpClientFactory({ copilotBin: this.config.copilotBin, cwd, logger: this.logger });
    const session = this._registerSession(threadId, acp, cwd);

    try {
      await acp.initialize();
      const sessionId = await acp.sessionNew(cwd);
      session.copilotSessionId = sessionId;
      this.state.setThread(threadId, {
        copilotSessionId: sessionId,
        cwd,
        createdAt: this.state.getThread(threadId)?.createdAt || new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      await this._saveState();
    } catch (err) {
      this.logger.error('failed to start Copilot session', { threadId, error: err.message });
      await this.rest.createThreadMessage(threadId, {
        content: `❌ Failed to start a Copilot session: ${sanitizeErr(err)}. Use \`/reset\` to try again.`,
      });
      this._teardownSession(threadId);
      return;
    }

    await this._sendPrompt(session, promptText, attachments);
  }

  /**
   * @private
   * @param {string} threadId @param {{copilotSessionId:string, cwd:string}} persisted
   * @param {string} promptText @param {object[]} attachments
   */
  async _restoreSession(threadId, persisted, promptText, attachments) {
    const acp = this._acpClientFactory({
      copilotBin: this.config.copilotBin,
      cwd: persisted.cwd,
      logger: this.logger,
    });
    const session = this._registerSession(threadId, acp, persisted.cwd);

    try {
      await acp.initialize();
      const { method } = await acp.sessionResume(persisted.copilotSessionId, persisted.cwd);
      session.copilotSessionId = persisted.copilotSessionId;
      this.logger.info('resumed session', { threadId, method });
    } catch (err) {
      this.logger.warn('failed to resume Copilot session', { threadId, error: err.message });
      await this.rest.createThreadMessage(threadId, {
        content:
          `⚠️ Could not restore the previous Copilot session for this thread (${sanitizeErr(err)}). ` +
          'To avoid silently losing context, a new session was **not** started automatically. ' +
          'Run `/reset` to start a fresh session in this thread.',
      });
      this._teardownSession(threadId);
      return;
    }

    await this._sendPrompt(session, promptText, attachments);
  }

  /** @private @param {string} threadId @param {AcpClient} acp @param {string} cwd @returns {ThreadSession} */
  _registerSession(threadId, acp, cwd) {
    /** @type {ThreadSession} */
    const session = {
      threadId,
      cwd,
      acp,
      copilotSessionId: null,
      busy: false,
      streaming: null,
      // Set right before we deliberately close this exact session's ACP
      // child (teardown/reset/shutdown) so its (possibly async) 'exit'
      // event is recognized as expected rather than reported as a crash.
      expectedClose: false,
    };
    this._sessions.set(threadId, session);

    acp.on('notification', (method, params) => this._onAcpNotification(session, method, params));
    acp.on('reverse-request', (method, params, respond, respondError) =>
      this._onAcpReverseRequest(session, method, params, respond, respondError),
    );
    // Bound to this exact session object (not looked up by threadId at
    // event time), so a stale/delayed exit from a session that has since
    // been torn down and replaced can never mutate the replacement's state.
    acp.on('exit', (code, signal) => this._onAcpExit(session, code, signal));

    return session;
  }

  /**
   * Tears down the given thread's live session (if any): removes it from
   * the active-session map and closes its ACP child process. Marks the
   * session as an "expected close" first, so the resulting (possibly
   * asynchronous) child 'exit' event is not mistaken for an unexpected
   * crash and cannot affect whatever session/mapping replaces it later.
   * @private @param {string} threadId
   */
  _teardownSession(threadId) {
    const session = this._sessions.get(threadId);
    if (!session) return;
    this._sessions.delete(threadId);
    session.expectedClose = true;
    try {
      session.acp.close();
    } catch {
      // already exited
    }
  }

  /** @private @param {ThreadSession} session @param {number|null} code @param {string|null} signal */
  async _onAcpExit(session, code, signal) {
    if (this._shuttingDown) return;
    if (session.expectedClose) {
      // Deliberate teardown (reset, restore-failure cleanup, or shutdown)
      // already handled removing this session and notifying the user, if
      // appropriate; the child exiting afterwards is expected, not a fault.
      this.logger.debug('ACP child exited after expected close', { threadId: session.threadId, code, signal });
      return;
    }
    // Ignore stale exits from a session that has already been replaced (by
    // teardown+restart racing with a slow real-process exit): only act if
    // this is still the live session registered for the thread.
    if (this._sessions.get(session.threadId) !== session) return;
    this.logger.warn('ACP child exited unexpectedly', { threadId: session.threadId, code, signal });
    this._sessions.delete(session.threadId);
    this.permissions.cancelForThread(session.threadId);
    try {
      await this.rest.createThreadMessage(session.threadId, {
        content: '⚠️ The Copilot process exited unexpectedly. Send a new message to start a fresh session, or use `/reset`.',
      });
    } catch {
      // best-effort notification
    }
  }

  /** @private @param {ThreadSession} session @param {string} method @param {object} params */
  _onAcpNotification(session, method, params) {
    if (method !== 'session/update') return;
    if (!session.streaming) return;
    const update = params?.update;
    if (!update) return;
    switch (update.sessionUpdate) {
      case 'agent_message_chunk': {
        const text = extractText(update.content);
        if (text) session.streaming.appendText(text);
        break;
      }
      case 'tool_call': {
        session.streaming.appendToolStatus(`🔧 ${update.title || update.toolCallId || 'tool call'} — ${update.status || 'pending'}`);
        break;
      }
      case 'tool_call_update': {
        session.streaming.appendToolStatus(`🔧 ${update.title || update.toolCallId || 'tool call'} — ${update.status || 'updated'}`);
        break;
      }
      default:
        break; // usage_update, available_commands_update: no user-facing spam in v1
    }
  }

  /**
   * @private
   * @param {ThreadSession} session @param {string} method @param {object} params
   * @param {(result:object)=>void} respond @param {(code:number,message:string)=>void} respondError
   */
  async _onAcpReverseRequest(session, method, params, respond, respondError) {
    if (method !== 'session/request_permission') {
      respondError(-32601, `Method not supported: ${method}`);
      return;
    }
    try {
      const result = await this.permissions.requestPermission({
        threadId: session.threadId,
        requestId: params.requestId,
        toolCall: params.toolCall,
        options: params.options || [],
      });
      respond(result);
    } catch (err) {
      this.logger.error('permission request handling failed', { error: err.message });
      respond({ outcome: { outcome: 'cancelled' } });
    }
  }

  /** @private @param {ThreadSession} session @param {string} rawText @param {object[]} attachments */
  async _sendPrompt(session, rawText, attachments) {
    const text = truncate((rawText || '').trim(), MAX_PROMPT_TEXT_CHARS);
    const blocks = [];
    if (text) blocks.push({ type: 'text', text });

    if (attachments.length > 0) {
      const { blocks: attBlocks, rejected } = await processAttachments(
        attachments,
        {
          maxBytes: this.config.attachmentMaxBytes,
          maxCount: this.config.attachmentMaxCount,
          imagesSupported: typeof session.acp.supportsImages === 'function' && session.acp.supportsImages(),
        },
        this._fetch,
      );
      blocks.push(...attBlocks);
      if (rejected.length > 0) {
        const lines = rejected.map((r) => `- \`${r.filename}\`: ${r.reason}`).join('\n');
        await this.rest.createThreadMessage(session.threadId, {
          content: `⚠️ Some attachments were not included:\n${lines}`,
        });
      }
    }

    if (blocks.length === 0) {
      await this.rest.createThreadMessage(session.threadId, {
        content: 'ℹ️ Nothing to send (empty message with no usable attachments).',
      });
      return;
    }

    session.busy = true;
    session.streaming = new StreamingReply({
      restClient: this.rest,
      threadId: session.threadId,
      logger: this.logger,
    });
    await session.streaming.start();

    try {
      const result = await session.acp.sessionPrompt(session.copilotSessionId, blocks);
      await session.streaming.finalize();
      this.logger.info('prompt turn completed', { threadId: session.threadId, stopReason: result?.stopReason });
    } catch (err) {
      await session.streaming.fail(describePromptError(err));
    } finally {
      session.busy = false;
      session.streaming = null;
      this.state.setThread(session.threadId, {
        ...this.state.getThread(session.threadId),
        updatedAt: new Date().toISOString(),
      });
      await this._saveState();
    }
  }

  // --- Interactions (slash commands + permission buttons) -------------------

  /** @private @param {object} interaction */
  async _onInteractionCreate(interaction) {
    if (interaction.type === INTERACTION_TYPE.MESSAGE_COMPONENT) {
      await this._onComponentInteraction(interaction);
      return;
    }
    if (interaction.type !== INTERACTION_TYPE.APPLICATION_COMMAND) return;

    const admission = validateInteraction(interaction, {
      guildId: this.config.discordGuildId,
      userId: this.config.discordUserId,
      channelId: this.config.discordChannelId,
      isKnownThread: (id) => this._isKnownThread(id),
    });
    if (!admission.ok) {
      await this._respondInteraction(interaction, ephemeralResponse('Not authorized.'));
      return;
    }

    const threadId = interaction.channel_id;
    const name = interaction.data?.name;
    if (name === 'status') {
      await this._respondInteraction(interaction, ephemeralResponse(this._statusText(threadId)));
      return;
    }
    if (name === 'cancel') {
      const session = this._sessions.get(threadId);
      if (session?.copilotSessionId) session.acp.sessionCancel(session.copilotSessionId);
      this.permissions.cancelForThread(threadId);
      await this._respondInteraction(interaction, ephemeralResponse('Cancelled current prompt and pending approvals (if any).'));
      return;
    }
    if (name === 'reset') {
      // ACK immediately (deferred ephemeral response) so we always meet
      // Discord's 3-second interaction callback deadline - the reset itself
      // (closing the ACP session) can take much longer than that. The final
      // user-visible confirmation is delivered by editing the original
      // response once the reset has actually completed.
      await this._respondInteraction(interaction, deferredEphemeralResponse());
      await this._resetThread(threadId);
      await this._editOriginalResponse(
        interaction,
        'Session reset. The next message in this thread will start a fresh Copilot session.',
      );
      return;
    }

    await this._respondInteraction(interaction, ephemeralResponse('Unknown command.'));
  }

  /** @private @param {object} interaction */
  async _onComponentInteraction(interaction) {
    const result = this.permissions.handleComponentClick({
      customId: interaction.data?.custom_id || '',
      userId: interaction.member?.user?.id || interaction.user?.id,
      channelId: interaction.channel_id,
      messageId: interaction.message?.id,
    });
    // Ack the click quickly and unobtrusively; the visible message is
    // updated separately by the PermissionManager via a REST edit.
    await this._respondInteraction(interaction, {
      type: 6, // DEFERRED_UPDATE_MESSAGE
    });
    if (!result.ok) {
      this.logger.debug('rejected permission click', { reason: result.reason });
    }
  }

  /** @private @param {object} interaction @param {object} body */
  async _respondInteraction(interaction, body) {
    try {
      await this.rest.createInteractionResponse(interaction.id, interaction.token, body);
    } catch (err) {
      this.logger.error('failed to respond to interaction', { error: err.message });
    }
  }

  /**
   * Edits the original interaction response (used after a deferred ACK, e.g.
   * for `/reset`). Best-effort: failures are logged, never thrown, since the
   * interaction has already been ACKed.
   * @private @param {object} interaction @param {string} content
   */
  async _editOriginalResponse(interaction, content) {
    if (!this._applicationId) return;
    try {
      await this.rest.editOriginalInteractionResponse(this._applicationId, interaction.token, { content });
    } catch (err) {
      this.logger.error('failed to edit original interaction response', { error: err.message });
    }
  }

  /** @private @param {string} threadId */
  async _resetThread(threadId) {
    this.permissions.cancelForThread(threadId);
    const session = this._sessions.get(threadId);
    if (session) {
      if (session.copilotSessionId) {
        try {
          await session.acp.sessionClose(session.copilotSessionId);
        } catch {
          // best-effort
        }
      }
      this._teardownSession(threadId);
    }
    const persisted = this.state.getThread(threadId);
    if (persisted) {
      this.state.setThread(threadId, { ...persisted, copilotSessionId: null, updatedAt: new Date().toISOString() });
      await this._saveState();
    }
  }

  /** @private @param {string} threadId @returns {string} */
  _statusText(threadId) {
    const persisted = this.state.getThread(threadId);
    if (!persisted) return 'This thread is not a known Copilot session thread.';
    const session = this._sessions.get(threadId);
    const busy = session?.busy ? 'busy' : 'idle';
    const shortSessionId = persisted.copilotSessionId
      ? `${persisted.copilotSessionId.slice(0, 8)}…`
      : '(none — will start fresh on next message)';
    return [
      `**cwd:** \`${persisted.cwd}\``,
      `**state:** ${session ? busy : 'not running (will lazily restore)'}`,
      `**copilot session:** ${shortSessionId}`,
      `**active sessions:** ${this._activeSessionCount()}/${this.config.maxSessions}`,
    ].join('\n');
  }

  /** @private */
  async _saveState() {
    try {
      await this.state.save();
    } catch (err) {
      this.logger.error('failed to persist state', { error: err.message });
    }
  }

  /** Graceful shutdown: stop accepting events, cancel work, close children, save, close gateway. */
  async shutdown() {
    this._shuttingDown = true;
    for (const [threadId, session] of this._sessions) {
      if (session.copilotSessionId) {
        try {
          session.acp.sessionCancel(session.copilotSessionId);
        } catch {
          // best-effort
        }
      }
      this.permissions.cancelForThread(threadId);
      try {
        session.acp.close();
      } catch {
        // best-effort
      }
    }
    this._sessions.clear();
    await this._saveState();
    this.gateway.close();
  }
}

/** @param {object[]|undefined} content ACP ContentBlock[] or a single block */
function extractText(content) {
  if (!content) return '';
  const blocks = Array.isArray(content) ? content : [content];
  return blocks
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('');
}

/** @param {string} s @param {number} n */
function truncate(s, n) {
  return s.length > n ? s.slice(0, n) + '…' : s;
}

/** @param {Error} err */
function sanitizeErr(err) {
  return String(err?.message || err).slice(0, 300);
}

/** @param {Error} err */
function describePromptError(err) {
  if (err instanceof AcpChildExitError) return 'The Copilot process exited before finishing this response.';
  if (err instanceof AcpProtocolError) return `Copilot reported an error: ${sanitizeErr(err)}`;
  return `An error occurred while waiting for a response: ${sanitizeErr(err)}`;
}

/**
 * @typedef {object} ThreadSession
 * @property {string} threadId
 * @property {string} cwd
 * @property {AcpClient} acp
 * @property {string|null} copilotSessionId
 * @property {boolean} busy
 * @property {StreamingReply|null} streaming
 */
