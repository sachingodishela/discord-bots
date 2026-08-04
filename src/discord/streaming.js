/**
 * Streaming Discord replies for a single Copilot ACP prompt turn.
 *
 * - Creates a placeholder message immediately.
 * - Coalesces `agent_message_chunk` text and edits at most once per ~1.5s.
 * - Splits content across sequential messages when it would exceed
 *   Discord's 2000-character limit, without losing content.
 * - Emits compact tool-call status lines (not raw tool output).
 * - `finalize()` flushes any pending edit immediately.
 */

export const DISCORD_MESSAGE_LIMIT = 2000;
const DEFAULT_EDIT_INTERVAL_MS = 1500;

export class StreamingReply {
  /**
   * @param {{restClient: import('./rest.js').DiscordRestClient, threadId: string, logger: import('../logger.js').Logger, editIntervalMs?: number, setIntervalImpl?: typeof setInterval, clearIntervalImpl?: typeof clearInterval, now?: () => number}} opts
   */
  constructor(opts) {
    this._rest = opts.restClient;
    this._threadId = opts.threadId;
    this.logger = opts.logger?.child ? opts.logger.child({ component: 'streaming' }) : opts.logger;
    this._editIntervalMs = opts.editIntervalMs ?? DEFAULT_EDIT_INTERVAL_MS;
    this._setInterval = opts.setIntervalImpl || setInterval;
    this._clearInterval = opts.clearIntervalImpl || clearInterval;

    /** @type {string[]} completed message contents (already sent/finalized) */
    this._completedMessages = [];
    /** @type {string|null} id of the currently-live (still editable) message */
    this._liveMessageId = null;
    /** @type {string} accumulated text for the currently-live message */
    this._liveText = '';
    this._dirty = false;
    this._started = false;
    this._finalized = false;
    this._timer = null;
    this._editInFlight = Promise.resolve();
  }

  /** Creates the placeholder message and starts the edit-throttle timer. */
  async start() {
    if (this._started) return;
    this._started = true;
    const message = await this._rest.createThreadMessage(this._threadId, { content: '⏳ working…' });
    this._liveMessageId = message.id;
    this._timer = this._setInterval(() => this._tick(), this._editIntervalMs);
  }

  /**
   * Appends streamed agent text.
   * @param {string} text
   */
  appendText(text) {
    if (!text) return;
    this._liveText += text;
    this._dirty = true;
  }

  /**
   * Appends a compact tool-status line (e.g. "🔧 Running `grep`…"), not raw
   * tool output.
   * @param {string} statusLine
   */
  appendToolStatus(statusLine) {
    const line = `\n_${sanitize(statusLine)}_`;
    this._liveText += line;
    this._dirty = true;
  }

  /** @private */
  async _tick() {
    if (!this._dirty) return;
    await this._flush();
  }

  /** @private splits live text into full completed messages + remaining live text if over the limit */
  _splitIfNeeded() {
    while (this._liveText.length > DISCORD_MESSAGE_LIMIT) {
      let cut = this._liveText.lastIndexOf('\n', DISCORD_MESSAGE_LIMIT);
      if (cut <= 0) cut = DISCORD_MESSAGE_LIMIT;
      const head = this._liveText.slice(0, cut);
      this._completedMessages.push({ id: this._liveMessageId, content: head, final: true });
      this._liveText = this._liveText.slice(cut).replace(/^\n/, '');
      this._liveMessageId = null; // needs a new message on next flush
    }
  }

  /** @private serializes edits/creates so concurrent flushes don't race */
  async _flush() {
    this._dirty = false;
    this._splitIfNeeded();

    this._editInFlight = this._editInFlight.then(async () => {
      // Finalize any messages produced by splitting.
      for (const msg of this._completedMessages) {
        if (msg.done) continue;
        try {
          if (msg.id) {
            await this._rest.editMessage(this._threadId, msg.id, { content: msg.content });
          } else {
            const created = await this._rest.createThreadMessage(this._threadId, { content: msg.content });
            msg.id = created.id;
          }
          msg.done = true;
        } catch (err) {
          this.logger?.warn?.('failed to finalize split message', { error: err.message });
        }
      }

      const displayText = this._liveText.length > 0 ? this._liveText : '⏳ working…';
      try {
        if (this._liveMessageId) {
          await this._rest.editMessage(this._threadId, this._liveMessageId, { content: displayText });
        } else {
          const created = await this._rest.createThreadMessage(this._threadId, { content: displayText });
          this._liveMessageId = created.id;
        }
      } catch (err) {
        this.logger?.warn?.('failed to update streaming message', { error: err.message });
      }
    });
    await this._editInFlight;
  }

  /**
   * Flushes any pending content and stops the throttle timer. Safe to call
   * multiple times.
   * @param {{suffix?: string}} [opts] optional text (e.g. stop reason) appended before final flush
   */
  async finalize(opts = {}) {
    if (this._finalized) return;
    this._finalized = true;
    if (this._timer) this._clearInterval(this._timer);
    if (opts.suffix) {
      this._liveText += opts.suffix;
    }
    if (this._liveText.trim() === '' && this._completedMessages.length === 0) {
      this._liveText = '_(no response)_';
    }
    await this._flush();
  }

  /** Reports an error to the user in-place, finalizing the reply. */
  async fail(message) {
    if (this._finalized) return;
    this._finalized = true;
    if (this._timer) this._clearInterval(this._timer);
    this._liveText += `\n\n❌ ${sanitize(message)}`;
    await this._flush();
  }
}

/** @param {string} s */
function sanitize(s) {
  return String(s).replace(/[\r`]/g, ' ').slice(0, 300);
}
