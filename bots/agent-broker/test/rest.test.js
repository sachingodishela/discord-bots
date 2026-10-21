import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { DiscordRestClient, DiscordApiError, sanitizeRoute } from '../src/discord/rest.js';
import { createLogger } from '../src/logger.js';

const SENTINEL_TOKEN = 'super-secret-interaction-token-should-never-leak-anywhere-1234567890';

function makeLogger() {
  const lines = [];
  const logger = createLogger({ logLevel: 'debug' }, { write: (line) => lines.push(line) });
  return { logger, lines };
}

function jsonResponse(status, body, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: 'status-text',
    headers: { get: (k) => headers[k.toLowerCase()] ?? null },
    json: async () => body,
  };
}

describe('sanitizeRoute', () => {
  test('redacts interaction callback tokens', () => {
    const route = `/interactions/123456789/${SENTINEL_TOKEN}/callback`;
    const out = sanitizeRoute(route);
    assert.ok(!out.includes(SENTINEL_TOKEN));
    assert.match(out, /\/interactions\/123456789\/\[REDACTED\]\/callback/);
  });

  test('redacts webhook edit-original tokens', () => {
    const route = `/webhooks/987654321/${SENTINEL_TOKEN}/messages/@original`;
    const out = sanitizeRoute(route);
    assert.ok(!out.includes(SENTINEL_TOKEN));
    assert.match(out, /\/webhooks\/987654321\/\[REDACTED\]\/messages\/@original/);
  });

  test('leaves non-sensitive routes untouched', () => {
    assert.equal(sanitizeRoute('/channels/123/messages'), '/channels/123/messages');
  });
});

describe('DiscordRestClient urgent vs normal queue', () => {
  test('an urgent request (interaction callback) is not blocked behind a slow queued normal request', async () => {
    const { logger } = makeLogger();
    let releaseSlow;
    const slowGate = new Promise((r) => (releaseSlow = r));
    const calls = [];
    const fetchImpl = async (url) => {
      calls.push(url);
      if (url.includes('/channels/')) {
        await slowGate; // normal-priority request blocks until released
        return jsonResponse(200, {});
      }
      return jsonResponse(200, {}); // urgent interaction callback resolves immediately
    };
    const client = new DiscordRestClient('fake-token', logger, { fetchImpl });

    const normalPromise = client.createMessage('chan-1', { content: 'slow' });
    // Give the normal request a chance to actually start (and block) first.
    await new Promise((r) => setTimeout(r, 10));

    const urgentDone = { settled: false };
    const urgentPromise = client
      .createInteractionResponse('interaction-1', SENTINEL_TOKEN, { type: 4, data: { content: 'ack' } })
      .then(() => (urgentDone.settled = true));

    await new Promise((r) => setTimeout(r, 20));
    assert.equal(urgentDone.settled, true, 'urgent interaction callback must complete without waiting for the slow normal request');

    releaseSlow();
    await normalPromise;
    await urgentPromise;
  });

  test('urgent requests use a shorter timeout and a single retry budget on repeated 429s', async () => {
    const { logger } = makeLogger();
    let attempts = 0;
    const fetchImpl = async () => {
      attempts += 1;
      return jsonResponse(429, { retry_after: 0.01 });
    };
    const client = new DiscordRestClient('fake-token', logger, { fetchImpl });

    await assert.rejects(
      () => client.createInteractionResponse('interaction-1', SENTINEL_TOKEN, { type: 4 }),
      DiscordApiError,
    );
    // URGENT_MAX_RETRIES = 1 -> initial attempt + one retry = 2 attempts total.
    assert.equal(attempts, 2);
  });

  test('normal-priority requests retry more times on repeated 429s than urgent ones', async () => {
    const { logger } = makeLogger();
    let attempts = 0;
    const fetchImpl = async () => {
      attempts += 1;
      return jsonResponse(429, { retry_after: 0.01 });
    };
    const client = new DiscordRestClient('fake-token', logger, { fetchImpl });

    await assert.rejects(() => client.createMessage('chan-1', { content: 'x' }), DiscordApiError);
    assert.ok(attempts > 2, `expected normal requests to retry more than urgent ones, got ${attempts} attempts`);
  });
});

describe('DiscordRestClient token/route leak prevention', () => {
  test('a failing interaction callback never leaks the interaction token in the thrown error', async () => {
    const { logger } = makeLogger();
    const fetchImpl = async () => jsonResponse(404, { message: 'Unknown interaction', code: 10062 });
    const client = new DiscordRestClient('fake-token', logger, { fetchImpl });

    await assert.rejects(
      () => client.createInteractionResponse('interaction-1', SENTINEL_TOKEN, { type: 4 }),
      (err) => {
        assert.ok(err instanceof DiscordApiError);
        assert.ok(!err.message.includes(SENTINEL_TOKEN), 'error message must not contain the raw token');
        assert.ok(!String(err.route).includes(SENTINEL_TOKEN), 'error.route must not contain the raw token');
        return true;
      },
    );
  });

  test('a rate-limited edit-original-response call never logs the webhook token', async () => {
    const { logger, lines } = makeLogger();
    let call = 0;
    const fetchImpl = async () => {
      call += 1;
      if (call === 1) return jsonResponse(429, { retry_after: 0.01 });
      return jsonResponse(200, {});
    };
    const client = new DiscordRestClient('fake-token', logger, { fetchImpl });

    await client.editOriginalInteractionResponse('app-1', SENTINEL_TOKEN, { content: 'done' });

    const allLogText = lines.join('\n');
    assert.ok(!allLogText.includes(SENTINEL_TOKEN), 'sentinel token must never appear in logged output');
  });
});
