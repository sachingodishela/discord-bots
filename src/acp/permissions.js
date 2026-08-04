/**
 * ACP permission-request bridge.
 *
 * When the Copilot agent sends a `session/request_permission` reverse
 * request, we post a Discord message in the owning thread with sanitized
 * tool details and two buttons: Allow Once and Reject. We deliberately do
 * NOT expose "allow_always"/"reject_always" in v1.
 *
 * Each button's custom_id is bound to a single-use, cryptographically random
 * nonce mapped (in memory only) to the exact pending request, the
 * originating thread, the operator user, and (once known) the message id.
 * Clicks are validated against all of these plus a 5-minute expiry; stale or
 * replayed clicks are rejected. Nonces/pending requests are never persisted.
 */
import { randomBytes } from 'node:crypto';

const TIMEOUT_MS = 5 * 60 * 1000;
const MAX_RAW_INPUT_CHARS = 800;
// Hard Discord message content limit; enforced as a final safety net after
// composing the whole permission-request message (title/kind/rawInput/etc).
const DISCORD_CONTENT_MAX_CHARS = 2000;

const SECRET_PATTERNS = [/gh[pousr]_[A-Za-z0-9]{20,}/g, /Bearer\s+[\w.\-]+/gi];

// Object keys that, regardless of their value's type or shape, must never be
// rendered in a permission request: their entire value is replaced with
// '[REDACTED]' before the object is even serialized. Matched by normalized
// (lowercased, non-alphanumeric-stripped) substring, so `api_key`,
// `Api-Key`, `apiKey`, etc. all match the same `apikey` fragment.
const SECRET_KEY_FRAGMENTS = ['token', 'auth', 'secret', 'password', 'cookie', 'apikey', 'credential', 'privatekey'];

/** @param {string} key @returns {boolean} true if this key name looks sensitive */
function isSecretKey(key) {
  const normalized = String(key).toLowerCase().replace(/[^a-z0-9]/g, '');
  return SECRET_KEY_FRAGMENTS.some((fragment) => normalized.includes(fragment));
}

/**
 * Recursively walks a JSON-like value, replacing the *entire value* of any
 * object property whose key looks sensitive (see isSecretKey) with the
 * literal string '[REDACTED]', regardless of what that value actually
 * contains (string, number, nested object, array, etc). Never mutates the
 * input; returns a redacted deep copy.
 * @param {unknown} value
 * @returns {unknown}
 */
function deepRedactKeys(value) {
  if (Array.isArray(value)) return value.map((item) => deepRedactKeys(item));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, v] of Object.entries(value)) {
      out[key] = isSecretKey(key) ? '[REDACTED]' : deepRedactKeys(v);
    }
    return out;
  }
  return value;
}

/** @param {string} text */
function redact(text) {
  let out = text;
  for (const re of SECRET_PATTERNS) out = out.replace(re, '[REDACTED]');
  return out;
}

/** @param {unknown} rawInput */
function formatRawInput(rawInput) {
  if (rawInput === undefined || rawInput === null) return null;
  let json;
  try {
    // First pass: redact whole values under sensitive-looking keys, however
    // they're nested, before anything is turned into a string.
    const safeValue = deepRedactKeys(rawInput);
    json = JSON.stringify(safeValue, null, 2);
  } catch {
    return '[unserializable]';
  }
  // Second pass: catch token-shaped *values* even under innocuous-looking
  // keys (e.g. a field not named "token" that nonetheless holds a GH/Bearer
  // token string).
  json = redact(json);
  if (json.length > MAX_RAW_INPUT_CHARS) {
    json = json.slice(0, MAX_RAW_INPUT_CHARS) + '\n...[truncated]';
  }
  return json;
}


export class PermissionManager {
  /**
   * @param {{restClient: import('../discord/rest.js').DiscordRestClient, operatorUserId: string, logger: import('../logger.js').Logger, now?: () => number, setTimeoutImpl?: typeof setTimeout, clearTimeoutImpl?: typeof clearTimeout}} opts
   */
  constructor(opts) {
    this._rest = opts.restClient;
    this._operatorUserId = opts.operatorUserId;
    this.logger = opts.logger.child({ component: 'permissions' });
    this._now = opts.now || (() => Date.now());
    this._setTimeout = opts.setTimeoutImpl || setTimeout;
    this._clearTimeout = opts.clearTimeoutImpl || clearTimeout;
    /** @type {Map<string, PendingPermission>} */
    this._pending = new Map();
  }

  /**
   * Presents a permission request in the given thread and resolves once the
   * operator responds, times out, or the request is cancelled.
   * @param {{threadId: string, requestId: string|number, toolCall: {title?:string, kind?:string, rawInput?:unknown}, options: {optionId:string, name?:string, kind?:string}[]}} req
   * @returns {Promise<{outcome: {outcome:'selected', optionId:string} | {outcome:'cancelled'}}>}
   */
  async requestPermission(req) {
    const allowOption = req.options?.find((o) => o.kind === 'allow_once' || o.optionId === 'allow_once');
    const rejectOption = req.options?.find(
      (o) => o.kind === 'reject_once' || o.optionId === 'reject_once' || o.optionId === 'reject',
    );

    const allowNonce = randomBytes(16).toString('hex');
    const rejectNonce = randomBytes(16).toString('hex');

    const rawInputText = formatRawInput(req.toolCall?.rawInput);
    const title = sanitizeLine(req.toolCall?.title || '(untitled tool call)');
    const kind = sanitizeLine(req.toolCall?.kind || 'unknown');

    let content = `🔐 **Permission requested**\n**Tool:** ${title}\n**Kind:** ${kind}`;
    if (rawInputText) {
      content += `\n\`\`\`json\n${rawInputText}\n\`\`\``;
    }
    content += '\n\n*This request will expire in 5 minutes if no action is taken.*';
    // Final safety net: no matter how the pieces above combine (long
    // title/kind, near-limit rawInput, etc), never exceed Discord's hard
    // 2000-char message content limit.
    if (content.length > DISCORD_CONTENT_MAX_CHARS) {
      content = content.slice(0, DISCORD_CONTENT_MAX_CHARS - 20) + '\n...[truncated]';
    }

    const components = [
      {
        type: 1,
        components: [
          {
            type: 2,
            style: 3,
            label: 'Allow Once',
            custom_id: `perm:${allowNonce}`,
            disabled: !allowOption,
          },
          {
            type: 2,
            style: 4,
            label: 'Reject',
            custom_id: `perm:${rejectNonce}`,
            disabled: !rejectOption,
          },
        ],
      },
    ];

    const message = await this._rest.createThreadMessage(req.threadId, { content, components });

    return new Promise((resolve) => {
      /** @type {PendingPermission} */
      const pending = {
        threadId: req.threadId,
        messageId: message.id,
        allowNonce,
        rejectNonce,
        allowOptionId: allowOption?.optionId,
        rejectOptionId: rejectOption?.optionId,
        used: false,
        resolve,
        timer: null,
      };
      pending.timer = this._setTimeout(() => this._expire(allowNonce), TIMEOUT_MS);
      this._pending.set(allowNonce, pending);
      this._pending.set(rejectNonce, pending);
    });
  }

  /** @private @param {string} anyNonce */
  async _expire(anyNonce) {
    const pending = this._pending.get(anyNonce);
    if (!pending || pending.used) return;
    pending.used = true;
    this._cleanup(pending);
    await this._safeEdit(pending, '⏱️ **Permission request timed out.**');
    pending.resolve({ outcome: { outcome: 'cancelled' } });
  }

  /**
   * Handles a MESSAGE_COMPONENT interaction click.
   * @param {{customId:string, userId:string, channelId:string, messageId:string}} click
   * @returns {{ok: boolean, reason?: string}}
   */
  handleComponentClick(click) {
    const nonce = click.customId.startsWith('perm:') ? click.customId.slice(5) : null;
    if (!nonce) return { ok: false, reason: 'not-a-permission-component' };

    const pending = this._pending.get(nonce);
    if (!pending) return { ok: false, reason: 'unknown-or-expired' };
    if (pending.used) return { ok: false, reason: 'already-used' };
    if (pending.threadId !== click.channelId) return { ok: false, reason: 'wrong-thread' };
    if (click.userId !== this._operatorUserId) return { ok: false, reason: 'wrong-user' };
    if (pending.messageId && pending.messageId !== click.messageId) {
      return { ok: false, reason: 'wrong-message' };
    }

    pending.used = true;
    this._clearTimeout(pending.timer);
    this._cleanup(pending);

    const isAllow = nonce === pending.allowNonce;
    const optionId = isAllow ? pending.allowOptionId : pending.rejectOptionId;
    if (!optionId) {
      pending.resolve({ outcome: { outcome: 'cancelled' } });
      return { ok: true, cancelled: true };
    }
    const label = isAllow ? '✅ Allowed once' : '🚫 Rejected';
    this._safeEdit(pending, `${label} by <@${click.userId}>.`).catch(() => {});
    pending.resolve({ outcome: { outcome: 'selected', optionId } });
    return { ok: true };
  }

  /**
   * Cancels all pending permission requests for a thread (e.g. on /cancel or
   * /reset), resolving them with a cancelled outcome.
   * @param {string} threadId
   */
  cancelForThread(threadId) {
    const seen = new Set();
    for (const [nonce, pending] of this._pending) {
      if (seen.has(pending)) continue;
      if (pending.threadId !== threadId || pending.used) continue;
      seen.add(pending);
      pending.used = true;
      this._clearTimeout(pending.timer);
      this._cleanup(pending);
      this._safeEdit(pending, '🚫 **Permission request cancelled.**').catch(() => {});
      pending.resolve({ outcome: { outcome: 'cancelled' } });
    }
  }

  /** @private @param {PendingPermission} pending */
  _cleanup(pending) {
    this._pending.delete(pending.allowNonce);
    this._pending.delete(pending.rejectNonce);
  }

  /** @private @param {PendingPermission} pending @param {string} content */
  async _safeEdit(pending, content) {
    try {
      await this._rest.editMessage(pending.threadId, pending.messageId, { content, components: [] });
    } catch (err) {
      this.logger.warn('failed to edit permission message', { error: err.message });
    }
  }
}

/** @param {string} s */
function sanitizeLine(s) {
  return String(s).replace(/[\r\n`]/g, ' ').slice(0, 200);
}

/**
 * @typedef {object} PendingPermission
 * @property {string} threadId
 * @property {string} messageId
 * @property {string} allowNonce
 * @property {string} rejectNonce
 * @property {string|undefined} allowOptionId
 * @property {string|undefined} rejectOptionId
 * @property {boolean} used
 * @property {(v:any)=>void} resolve
 * @property {NodeJS.Timeout|null} timer
 */
