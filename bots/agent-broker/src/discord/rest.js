/**
 * Discord REST API client.
 *
 * - Requests are serialized through a single in-process queue (simple,
 *   correct-by-construction rate limiting suitable for a single-guild bot).
 * - Interaction callbacks (the initial ACK Discord requires within 3
 *   seconds) run through a *separate* "urgent" queue with a much shorter
 *   timeout, so they are never blocked behind a slow/serialized normal
 *   request (e.g. a message edit that's waiting out a rate limit).
 * - Handles per-request 429 responses (using `retry_after`) and the global
 *   rate limit flag, with bounded retries and per-request timeouts.
 * - Never logs the Authorization header or interaction/webhook tokens: route
 *   strings are sanitized (token path segments redacted) before they ever
 *   reach a log line or an Error message/property.
 */

const API_BASE = 'https://discord.com/api/v10';
const MAX_RETRIES = 5;
const REQUEST_TIMEOUT_MS = 15_000;

// Interaction callbacks must reach Discord within 3s of the interaction
// being created; keep well under that even after accounting for the
// serialized-queue wait time of zero (urgent requests use their own queue).
const URGENT_REQUEST_TIMEOUT_MS = 2_000;
const URGENT_MAX_RETRIES = 1;

/**
 * Redacts interaction/webhook tokens embedded in Discord route paths, e.g.
 * `/interactions/<id>/<token>/callback` and
 * `/webhooks/<appId>/<token>/messages/@original`. Always applied before a
 * route string is used in a log line or an Error message/property.
 * @param {string} route
 * @returns {string}
 */
function sanitizeRoute(route) {
  if (typeof route !== 'string') return route;
  return route
    .replace(/(\/interactions\/[^/]+\/)[^/]+/, '$1[REDACTED]')
    .replace(/(\/webhooks\/[^/]+\/)[^/]+/, '$1[REDACTED]');
}

export class DiscordApiError extends Error {
  /**
   * @param {string} message
   * @param {{status?: number, code?: number, route?: string}} [info]
   */
  constructor(message, info = {}) {
    super(message);
    this.name = 'DiscordApiError';
    this.status = info.status;
    this.code = info.code;
    this.route = info.route !== undefined ? sanitizeRoute(info.route) : info.route;
  }
}

export class DiscordRestClient {
  /**
   * @param {string} token
   * @param {import('../logger.js').Logger} logger
   * @param {{fetchImpl?: typeof fetch, apiBase?: string}} [opts]
   */
  constructor(token, logger, opts = {}) {
    this._token = token;
    this.logger = logger.child({ component: 'discord-rest' });
    this._fetch = opts.fetchImpl || fetch;
    this._apiBase = opts.apiBase || API_BASE;
    /** @type {Promise<any>} tail of the serialized "normal" queue */
    this._queue = Promise.resolve();
    /**
     * @type {Promise<any>} tail of the "urgent" queue used for
     * time-critical interaction callbacks. Kept entirely separate from
     * `_queue` so a slow/rate-limited normal request can never delay an
     * interaction ACK past Discord's 3-second deadline.
     */
    this._urgentQueue = Promise.resolve();
    this._globalRateLimitUntil = 0;
  }

  /**
   * Enqueues a request so all REST calls of the same priority run strictly
   * one-at-a-time, without blocking on the other priority's queue.
   * @template T
   * @param {() => Promise<T>} fn
   * @param {{urgent?: boolean}} [opts]
   * @returns {Promise<T>}
   */
  _enqueue(fn, { urgent = false } = {}) {
    const queueKey = urgent ? '_urgentQueue' : '_queue';
    const run = this[queueKey].then(fn, fn);
    // Swallow rejections in the queue tail so one failure doesn't wedge
    // subsequent requests; callers still see their own rejection.
    this[queueKey] = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /**
   * @param {string} method
   * @param {string} route path beginning with '/'
   * @param {{body?: object, reason?: string, urgent?: boolean}} [opts]
   * @returns {Promise<any>}
   */
  async request(method, route, opts = {}) {
    return this._enqueue(() => this._requestOnce(method, route, opts, 0), { urgent: !!opts.urgent });
  }

  /** @private */
  async _requestOnce(method, route, opts, attempt) {
    const urgent = !!opts.urgent;
    const maxRetries = urgent ? URGENT_MAX_RETRIES : MAX_RETRIES;
    const timeoutMs = urgent ? URGENT_REQUEST_TIMEOUT_MS : REQUEST_TIMEOUT_MS;
    const safeRoute = sanitizeRoute(route);
    const now = Date.now();
    if (!urgent && now < this._globalRateLimitUntil) {
      await sleep(this._globalRateLimitUntil - now);
    }

    const headers = {
      Authorization: `Bot ${this._token}`,
      'Content-Type': 'application/json',
      'User-Agent': 'discord-copilot-broker (https://github.com/sachin/discord-copilot-broker, 1.0.0)',
    };
    if (opts.reason) headers['X-Audit-Log-Reason'] = encodeURIComponent(opts.reason);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res;
    try {
      res = await this._fetch(`${this._apiBase}${route}`, {
        method,
        headers,
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      if (attempt < maxRetries) {
        await sleep(backoffMs(attempt));
        return this._requestOnce(method, route, opts, attempt + 1);
      }
      throw new DiscordApiError(`Network error calling Discord API: ${err.message}`, { route: safeRoute });
    }
    clearTimeout(timer);

    if (res.status === 429) {
      const data = await safeJson(res);
      const retryAfterSec = Number(data?.retry_after ?? res.headers.get('retry-after') ?? 1);
      const isGlobal = data?.global === true || res.headers.get('x-ratelimit-global') === 'true';
      if (isGlobal) {
        this._globalRateLimitUntil = Date.now() + retryAfterSec * 1000;
      }
      this.logger.warn('rate limited', { route: safeRoute, retryAfterSec, global: isGlobal, attempt, urgent });
      if (attempt >= maxRetries) {
        throw new DiscordApiError('Exceeded retries after rate limiting', { status: 429, route: safeRoute });
      }
      await sleep(retryAfterSec * 1000);
      return this._requestOnce(method, route, opts, attempt + 1);
    }

    if (res.status >= 500 && attempt < maxRetries) {
      await sleep(backoffMs(attempt));
      return this._requestOnce(method, route, opts, attempt + 1);
    }

    if (!res.ok) {
      const data = await safeJson(res);
      throw new DiscordApiError(
        `Discord API error ${res.status} on ${method} ${safeRoute}: ${data?.message ?? res.statusText}`,
        { status: res.status, code: data?.code, route: safeRoute },
      );
    }

    if (res.status === 204) return null;
    return safeJson(res);
  }

  // --- Convenience methods -------------------------------------------------

  /** @param {string} channelId @param {object} body */
  createMessage(channelId, body) {
    return this.request('POST', `/channels/${channelId}/messages`, { body });
  }

  /** @param {string} channelId @param {string} messageId @param {object} body */
  editMessage(channelId, messageId, body) {
    return this.request('PATCH', `/channels/${channelId}/messages/${messageId}`, { body });
  }

  /** @param {string} channelId @param {string} messageId @param {object} body */
  startThreadFromMessage(channelId, messageId, body) {
    return this.request('POST', `/channels/${channelId}/messages/${messageId}/threads`, { body });
  }

  /** @param {string} threadId @param {object} body */
  createThreadMessage(threadId, body) {
    return this.createMessage(threadId, body);
  }

  /** @param {string} channelId */
  deleteChannel(channelId) {
    return this.request('DELETE', `/channels/${channelId}`);
  }

  /**
   * PUTs the full guild application command set (replaces existing set).
   * @param {string} applicationId @param {string} guildId @param {object[]} commands
   */
  putGuildApplicationCommands(applicationId, guildId, commands) {
    return this.request('PUT', `/applications/${applicationId}/guilds/${guildId}/commands`, {
      body: commands,
    });
  }

  /**
   * @param {string} interactionId @param {string} interactionToken @param {object} body
   *
   * Runs on the urgent queue: Discord requires interaction callbacks within
   * 3 seconds, so this must never be blocked behind a slow/serialized
   * normal-priority request.
   */
  createInteractionResponse(interactionId, interactionToken, body) {
    return this.request(
      'POST',
      `/interactions/${interactionId}/${interactionToken}/callback`,
      { body, urgent: true },
    );
  }

  /** @param {string} applicationId @param {string} interactionToken @param {object} body */
  editOriginalInteractionResponse(applicationId, interactionToken, body) {
    return this.request(
      'PATCH',
      `/webhooks/${applicationId}/${interactionToken}/messages/@original`,
      { body },
    );
  }

  /** @param {string} applicationId */
  getCurrentApplication(applicationId) {
    return this.request('GET', '/oauth2/applications/@me');
  }
}

/** @param {Response} res */
async function safeJson(res) {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

/** @param {number} attempt */
function backoffMs(attempt) {
  const base = Math.min(1000 * 2 ** attempt, 10_000);
  return base + Math.random() * 250;
}

/** @param {number} ms */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export { sanitizeRoute };
