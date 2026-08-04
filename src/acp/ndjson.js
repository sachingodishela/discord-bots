/**
 * NDJSON (newline-delimited JSON) framing helpers for the ACP stdio
 * transport.
 */

export class LineTooLongError extends Error {
  constructor(maxBytes) {
    super(`NDJSON line exceeded maximum size of ${maxBytes} bytes`);
    this.name = 'LineTooLongError';
  }
}

/** @param {object} obj @returns {string} */
export function encodeNdjson(obj) {
  return JSON.stringify(obj) + '\n';
}

const DEFAULT_MAX_LINE_BYTES = 10 * 1024 * 1024; // 10 MiB per line, bounded.

/**
 * Incremental NDJSON decoder. Buffers partial lines across `push()` calls
 * and enforces a maximum line size to bound memory use.
 */
export class NdjsonDecoder {
  /** @param {{maxLineBytes?: number}} [opts] */
  constructor(opts = {}) {
    this._buffer = '';
    this._maxLineBytes = opts.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES;
  }

  /**
   * Feeds a chunk of text (already utf8-decoded) into the decoder.
   * @param {string} chunk
   * @returns {{objects: any[], errors: Error[]}}
   */
  push(chunk) {
    this._buffer += chunk;
    if (Buffer.byteLength(this._buffer, 'utf8') > this._maxLineBytes && !this._buffer.includes('\n')) {
      const err = new LineTooLongError(this._maxLineBytes);
      this._buffer = '';
      return { objects: [], errors: [err] };
    }

    const objects = [];
    const errors = [];
    let idx;
    while ((idx = this._buffer.indexOf('\n')) !== -1) {
      const line = this._buffer.slice(0, idx);
      this._buffer = this._buffer.slice(idx + 1);
      const trimmed = line.replace(/\r$/, '');
      if (trimmed.trim() === '') continue;
      if (Buffer.byteLength(trimmed, 'utf8') > this._maxLineBytes) {
        errors.push(new LineTooLongError(this._maxLineBytes));
        continue;
      }
      try {
        objects.push(JSON.parse(trimmed));
      } catch (err) {
        errors.push(new Error(`Failed to parse NDJSON line: ${err.message}`));
      }
    }
    return { objects, errors };
  }
}
