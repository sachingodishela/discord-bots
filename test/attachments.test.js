import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { processAttachments, AttachmentRejectedError } from '../src/discord/attachments.js';

function textResponse(body, { status = 200, headers = {} } = {}) {
  const encoded = Buffer.from(body, 'utf8');
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k) => headers[k.toLowerCase()] ?? null },
    async arrayBuffer() {
      return encoded.buffer.slice(encoded.byteOffset, encoded.byteOffset + encoded.byteLength);
    },
    body: {
      getReader() {
        let done = false;
        return {
          async read() {
            if (done) return { done: true, value: undefined };
            done = true;
            return { done: false, value: new Uint8Array(encoded) };
          },
          async cancel() {},
        };
      },
    },
  };
}

function redirectResponse(location) {
  return {
    ok: false,
    status: 302,
    headers: { get: (k) => (k.toLowerCase() === 'location' ? location : null) },
  };
}

function makeFetch(handlers) {
  return async (url) => {
    const handler = handlers[url];
    if (!handler) throw new Error(`no mock handler for ${url}`);
    return handler();
  };
}

const LIMITS = { maxBytes: 1024, maxCount: 5, imagesSupported: true };

describe('processAttachments', () => {
  test('accepts a small text attachment as an ACP resource block', async () => {
    const url = 'https://cdn.discordapp.com/attachments/1/2/notes.txt';
    const fetchImpl = makeFetch({ [url]: () => textResponse('hello world') });
    const { blocks, rejected } = await processAttachments(
      [{ url, filename: 'notes.txt', size: 11, content_type: 'text/plain' }],
      LIMITS,
      fetchImpl,
    );
    assert.equal(rejected.length, 0);
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].type, 'resource');
    assert.equal(blocks[0].resource.text, 'hello world');
    assert.match(blocks[0].resource.uri, /notes\.txt$/);
  });

  test('accepts an image attachment as an image block when capability allows', async () => {
    const url = 'https://cdn.discordapp.com/attachments/1/2/pic.png';
    const fetchImpl = makeFetch({ [url]: () => textResponse('fake-png-bytes') });
    const { blocks, rejected } = await processAttachments(
      [{ url, filename: 'pic.png', size: 14, content_type: 'image/png' }],
      LIMITS,
      fetchImpl,
    );
    assert.equal(rejected.length, 0);
    assert.equal(blocks[0].type, 'image');
    assert.equal(blocks[0].mimeType, 'image/png');
  });

  test('rejects image attachment when agent does not support images', async () => {
    const url = 'https://cdn.discordapp.com/attachments/1/2/pic.png';
    const fetchImpl = makeFetch({ [url]: () => textResponse('fake-png-bytes') });
    const { blocks, rejected } = await processAttachments(
      [{ url, filename: 'pic.png', size: 14, content_type: 'image/png' }],
      { ...LIMITS, imagesSupported: false },
      fetchImpl,
    );
    assert.equal(blocks.length, 0);
    assert.equal(rejected.length, 1);
    assert.match(rejected[0].reason, /does not support image/);
  });

  test('rejects unsupported file extension/mime', async () => {
    const url = 'https://cdn.discordapp.com/attachments/1/2/archive.zip';
    const fetchImpl = makeFetch({ [url]: () => textResponse('PK...') });
    const { blocks, rejected } = await processAttachments(
      [{ url, filename: 'archive.zip', size: 5, content_type: 'application/zip' }],
      LIMITS,
      fetchImpl,
    );
    assert.equal(blocks.length, 0);
    assert.match(rejected[0].reason, /unsupported file type/);
  });

  test('rejects non-Discord-CDN hosts', async () => {
    const url = 'https://evil.example.com/file.txt';
    const fetchImpl = makeFetch({ [url]: () => textResponse('nope') });
    const { blocks, rejected } = await processAttachments(
      [{ url, filename: 'file.txt', size: 4, content_type: 'text/plain' }],
      LIMITS,
      fetchImpl,
    );
    assert.equal(blocks.length, 0);
    assert.match(rejected[0].reason, /disallowed host/);
  });

  test('rejects non-HTTPS URLs', async () => {
    const url = 'http://cdn.discordapp.com/attachments/1/2/notes.txt';
    const fetchImpl = makeFetch({ [url]: () => textResponse('hi') });
    const { blocks, rejected } = await processAttachments(
      [{ url, filename: 'notes.txt', size: 2, content_type: 'text/plain' }],
      LIMITS,
      fetchImpl,
    );
    assert.equal(blocks.length, 0);
    assert.match(rejected[0].reason, /non-HTTPS/);
  });

  test('rejects a redirect that leaves the allowed CDN hosts', async () => {
    const url = 'https://cdn.discordapp.com/attachments/1/2/redirecting.txt';
    const evilTarget = 'https://evil.example.com/steal.txt';
    const fetchImpl = makeFetch({
      [url]: () => redirectResponse(evilTarget),
    });
    const { blocks, rejected } = await processAttachments(
      [{ url, filename: 'redirecting.txt', size: 4, content_type: 'text/plain' }],
      LIMITS,
      fetchImpl,
    );
    assert.equal(blocks.length, 0);
    assert.match(rejected[0].reason, /disallowed host/);
  });

  test('allows a redirect that stays within allowed CDN hosts', async () => {
    const url = 'https://cdn.discordapp.com/attachments/1/2/redirecting.txt';
    const target = 'https://media.discordapp.net/attachments/1/2/final.txt';
    const fetchImpl = makeFetch({
      [url]: () => redirectResponse(target),
      [target]: () => textResponse('final content'),
    });
    const { blocks, rejected } = await processAttachments(
      [{ url, filename: 'redirecting.txt', size: 13, content_type: 'text/plain' }],
      LIMITS,
      fetchImpl,
    );
    assert.equal(rejected.length, 0);
    assert.equal(blocks[0].resource.text, 'final content');
  });

  test('rejects attachment declaring size over the remaining byte budget', async () => {
    const url = 'https://cdn.discordapp.com/attachments/1/2/big.txt';
    const fetchImpl = makeFetch({ [url]: () => textResponse('x'.repeat(2000)) });
    const { blocks, rejected } = await processAttachments(
      [{ url, filename: 'big.txt', size: 2000, content_type: 'text/plain' }],
      { ...LIMITS, maxBytes: 1024 },
      fetchImpl,
    );
    assert.equal(blocks.length, 0);
    assert.match(rejected[0].reason, /byte budget/);
  });

  test('rejects when actual downloaded bytes exceed budget despite a small declared size', async () => {
    const url = 'https://cdn.discordapp.com/attachments/1/2/lying.txt';
    const fetchImpl = makeFetch({ [url]: () => textResponse('y'.repeat(2000)) });
    const { blocks, rejected } = await processAttachments(
      [{ url, filename: 'lying.txt', size: 10, content_type: 'text/plain' }],
      { ...LIMITS, maxBytes: 1024 },
      fetchImpl,
    );
    assert.equal(blocks.length, 0);
    assert.match(rejected[0].reason, /byte budget/);
  });

  test('enforces max attachment count, rejecting the overflow', async () => {
    const urls = Array.from({ length: 7 }, (_, i) => `https://cdn.discordapp.com/attachments/1/2/f${i}.txt`);
    const handlers = {};
    for (const u of urls) handlers[u] = () => textResponse('x');
    const fetchImpl = makeFetch(handlers);
    const attachments = urls.map((url, i) => ({ url, filename: `f${i}.txt`, size: 1, content_type: 'text/plain' }));
    const { blocks, rejected } = await processAttachments(attachments, { ...LIMITS, maxCount: 5 }, fetchImpl);
    assert.equal(blocks.length, 5);
    assert.equal(rejected.length, 2);
  });

  test('total byte budget is shared across multiple attachments', async () => {
    const url1 = 'https://cdn.discordapp.com/attachments/1/2/a.txt';
    const url2 = 'https://cdn.discordapp.com/attachments/1/2/b.txt';
    const fetchImpl = makeFetch({
      [url1]: () => textResponse('a'.repeat(700)),
      [url2]: () => textResponse('b'.repeat(700)),
    });
    const { blocks, rejected } = await processAttachments(
      [
        { url: url1, filename: 'a.txt', size: 700, content_type: 'text/plain' },
        { url: url2, filename: 'b.txt', size: 700, content_type: 'text/plain' },
      ],
      { ...LIMITS, maxBytes: 1024 },
      fetchImpl,
    );
    assert.equal(blocks.length, 1);
    assert.equal(rejected.length, 1);
  });
});
