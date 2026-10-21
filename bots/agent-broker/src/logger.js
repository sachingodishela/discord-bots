/**
 * Minimal structured JSON logger with secret-safe metadata redaction.
 *
 * Never pass raw secrets (tokens, interaction tokens, prompt content,
 * attachment bytes, Copilot auth data) into log metadata. As defense in
 * depth, well-known secret-shaped keys and value patterns are redacted.
 */

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

const SECRET_KEY_RE = /(token|authorization|auth|secret|password|cookie|api[_-]?key)/i;

// Defense-in-depth patterns for common credential shapes that might leak
// into free-text messages (e.g. Discord bot/app tokens, GitHub tokens).
const SECRET_VALUE_PATTERNS = [
  /[MN][A-Za-z\d]{23}\.[\w-]{6}\.[\w-]{27,}/g, // Discord bot token shape
  /gh[pousr]_[A-Za-z0-9]{20,}/g, // GitHub tokens
  /Bearer\s+[\w.\-]+/gi,
];

/**
 * @param {string} text
 * @returns {string}
 */
function redactText(text) {
  let out = text;
  for (const re of SECRET_VALUE_PATTERNS) {
    out = out.replace(re, '[REDACTED]');
  }
  return out;
}

/**
 * Deep-redacts an object for logging: drops secret-shaped keys, redacts
 * secret-shaped string values, and bounds size.
 * @param {unknown} value
 * @param {number} depth
 * @returns {unknown}
 */
function redact(value, depth = 0) {
  if (depth > 4) return '[TRUNCATED]';
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') {
    const redacted = redactText(value);
    return redacted.length > 2000 ? `${redacted.slice(0, 2000)}...[TRUNCATED]` : redacted;
  }
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    return value.slice(0, 50).map((v) => redact(v, depth + 1));
  }
  const out = {};
  for (const [key, val] of Object.entries(value)) {
    if (SECRET_KEY_RE.test(key)) {
      out[key] = '[REDACTED]';
      continue;
    }
    out[key] = redact(val, depth + 1);
  }
  return out;
}

/**
 * @typedef {object} Logger
 * @property {(msg: string, meta?: object) => void} debug
 * @property {(msg: string, meta?: object) => void} info
 * @property {(msg: string, meta?: object) => void} warn
 * @property {(msg: string, meta?: object) => void} error
 * @property {(bindings: object) => Logger} child
 */

/**
 * @param {{logLevel?: string}} config
 * @param {{write?: (line: string) => void}} [opts]
 * @returns {Logger}
 */
export function createLogger(config, opts = {}) {
  const minLevel = LEVELS[config?.logLevel] ?? LEVELS.info;
  const write = opts.write || ((line) => process.stdout.write(line + '\n'));

  function makeLogger(bindings) {
    /** @param {string} level @param {string} msg @param {object} [meta] */
    function log(level, msg, meta) {
      if (LEVELS[level] < minLevel) return;
      const entry = {
        ts: new Date().toISOString(),
        level,
        msg: redactText(String(msg)),
        ...redact(bindings),
        ...(meta ? redact(meta) : {}),
      };
      write(JSON.stringify(entry));
    }
    return {
      debug: (msg, meta) => log('debug', msg, meta),
      info: (msg, meta) => log('info', msg, meta),
      warn: (msg, meta) => log('warn', msg, meta),
      error: (msg, meta) => log('error', msg, meta),
      child: (extra) => makeLogger({ ...bindings, ...extra }),
    };
  }

  return makeLogger({});
}
