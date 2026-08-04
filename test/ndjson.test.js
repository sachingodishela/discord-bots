import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { NdjsonDecoder, encodeNdjson, LineTooLongError } from '../src/acp/ndjson.js';

describe('NDJSON framing', () => {
  test('encodeNdjson appends newline and serializes', () => {
    const line = encodeNdjson({ a: 1 });
    assert.equal(line, '{"a":1}\n');
  });

  test('decodes a single full line delivered in one chunk', () => {
    const dec = new NdjsonDecoder();
    const { objects, errors } = dec.push('{"a":1}\n');
    assert.deepEqual(objects, [{ a: 1 }]);
    assert.deepEqual(errors, []);
  });

  test('buffers partial lines across chunks', () => {
    const dec = new NdjsonDecoder();
    let { objects } = dec.push('{"a":1');
    assert.deepEqual(objects, []);
    ({ objects } = dec.push(',"b":2}\n'));
    assert.deepEqual(objects, [{ a: 1, b: 2 }]);
  });

  test('decodes multiple lines in one chunk, preserving order', () => {
    const dec = new NdjsonDecoder();
    const { objects } = dec.push('{"n":1}\n{"n":2}\n{"n":3}\n');
    assert.deepEqual(objects.map((o) => o.n), [1, 2, 3]);
  });

  test('skips blank lines', () => {
    const dec = new NdjsonDecoder();
    const { objects, errors } = dec.push('\n{"n":1}\n\n');
    assert.deepEqual(objects, [{ n: 1 }]);
    assert.deepEqual(errors, []);
  });

  test('reports parse error for malformed line but keeps decoding subsequent lines', () => {
    const dec = new NdjsonDecoder();
    const { objects, errors } = dec.push('{not json}\n{"ok":true}\n');
    assert.equal(objects.length, 1);
    assert.equal(objects[0].ok, true);
    assert.equal(errors.length, 1);
  });

  test('enforces max line size and reports LineTooLongError', () => {
    const dec = new NdjsonDecoder({ maxLineBytes: 16 });
    const big = 'x'.repeat(100);
    const { objects, errors } = dec.push(`{"v":"${big}"}\n`);
    assert.deepEqual(objects, []);
    assert.equal(errors.length, 1);
    assert.ok(errors[0] instanceof LineTooLongError);
  });

  test('handles trailing CRLF line endings', () => {
    const dec = new NdjsonDecoder();
    const { objects } = dec.push('{"n":1}\r\n');
    assert.deepEqual(objects, [{ n: 1 }]);
  });
});
