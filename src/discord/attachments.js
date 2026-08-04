/**
 * Discord attachment handling.
 *
 * - HTTPS Discord CDN only, with a bounded fetch timeout and manual redirect
 *   handling so redirects can never leave the allowed CDN hosts.
 * - Enforces declared size and per-attachment/per-total byte budgets, and
 *   the configured maximum attachment count.
 * - Text allowlist files become ACP `resource` content blocks (embedded
 *   text). Images (png/jpeg/gif/webp) become ACP `image` blocks, but only
 *   if the agent capability permits it.
 * - Never written to host disk.
 */

const ALLOWED_HOSTS = new Set(['cdn.discordapp.com', 'media.discordapp.net']);
const FETCH_TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 3;

const TEXT_EXTENSIONS = new Set([
  '.txt', '.md', '.markdown', '.json', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx',
  '.py', '.rb', '.go', '.rs', '.java', '.c', '.h', '.cpp', '.hpp', '.cs', '.sh',
  '.bash', '.yml', '.yaml', '.toml', '.ini', '.cfg', '.conf', '.log', '.csv',
  '.diff', '.patch', '.sql', '.html', '.css', '.xml',
]);
const TEXT_MIME_PREFIXES = ['text/'];
const TEXT_MIME_EXACT = new Set(['application/json', 'application/x-yaml', 'application/xml']);

const IMAGE_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

export class AttachmentRejectedError extends Error {
  /** @param {string} filename @param {string} reason */
  constructor(filename, reason) {
    super(`Attachment "${filename}" rejected: ${reason}`);
    this.name = 'AttachmentRejectedError';
    this.filename = filename;
    this.reason = reason;
  }
}

/** @param {string} filename */
function sanitizeFilename(filename) {
  const base = String(filename || 'file').split(/[\\/]/).pop();
  return base.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 200) || 'file';
}

/** @param {string} filename */
function extOf(filename) {
  const idx = filename.lastIndexOf('.');
  return idx === -1 ? '' : filename.slice(idx).toLowerCase();
}

/** @param {string} mime */
function isTextMime(mime) {
  if (!mime) return false;
  const base = mime.split(';')[0].trim().toLowerCase();
  return TEXT_MIME_EXACT.has(base) || TEXT_MIME_PREFIXES.some((p) => base.startsWith(p));
}

/**
 * Validates a Discord attachment URL is https and on an allowed CDN host.
 * @param {string} urlString
 */
function assertAllowedUrl(urlString) {
  let url;
  try {
    url = new URL(urlString);
  } catch {
    throw new Error('invalid URL');
  }
  if (url.protocol !== 'https:') throw new Error('non-HTTPS URL rejected');
  if (!ALLOWED_HOSTS.has(url.hostname)) throw new Error(`disallowed host: ${url.hostname}`);
  return url;
}

/**
 * Fetches a single attachment, following at most MAX_REDIRECTS hops
 * manually, verifying each hop stays on an allowed CDN host.
 * @param {string} url
 * @param {typeof fetch} fetchImpl
 * @returns {Promise<Response>}
 */
async function fetchWithHostPinnedRedirects(url, fetchImpl) {
  let currentUrl = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    assertAllowedUrl(currentUrl);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    let res;
    try {
      res = await fetchImpl(currentUrl, { redirect: 'manual', signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      if (!location) throw new Error('redirect with no Location header');
      currentUrl = new URL(location, currentUrl).toString();
      continue;
    }
    return res;
  }
  throw new Error('too many redirects');
}

/**
 * Downloads and reads a response body up to a byte limit, aborting if
 * exceeded (defends against a server lying about Content-Length).
 * @param {Response} res
 * @param {number} maxBytes
 * @returns {Promise<Buffer>}
 */
async function readBounded(res, maxBytes) {
  if (!res.body) {
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > maxBytes) throw new Error('attachment exceeded byte budget');
    return buf;
  }
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new Error('attachment exceeded byte budget');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

/**
 * Validates and converts a set of Discord attachments into ACP content
 * blocks, enforcing count/size budgets.
 * @param {object[]} attachments Discord attachment objects ({url, filename, size, content_type})
 * @param {{maxBytes: number, maxCount: number, imagesSupported: boolean}} limits
 * @param {typeof fetch} [fetchImpl]
 * @returns {Promise<{blocks: object[], rejected: {filename:string, reason:string}[]}>}
 */
export async function processAttachments(attachments, limits, fetchImpl = fetch) {
  const blocks = [];
  const rejected = [];
  let remainingBytes = limits.maxBytes;

  if (attachments.length > limits.maxCount) {
    for (const a of attachments.slice(limits.maxCount)) {
      rejected.push({ filename: sanitizeFilename(a.filename), reason: `more than ${limits.maxCount} attachments` });
    }
    attachments = attachments.slice(0, limits.maxCount);
  }

  for (const att of attachments) {
    const filename = sanitizeFilename(att.filename);
    try {
      assertAllowedUrl(att.url);

      const declaredSize = Number(att.size ?? 0);
      if (declaredSize > remainingBytes) {
        throw new Error('exceeds remaining attachment byte budget');
      }

      const ext = extOf(filename);
      const mime = att.content_type || '';
      const isText = TEXT_EXTENSIONS.has(ext) || isTextMime(mime);
      const isImage = IMAGE_MIME_TYPES.has(mime.split(';')[0].trim().toLowerCase());

      if (!isText && !isImage) {
        throw new Error(`unsupported file type (ext=${ext || 'none'}, mime=${mime || 'unknown'})`);
      }
      if (isImage && !limits.imagesSupported) {
        throw new Error('agent does not support image content in this session');
      }

      const res = await fetchWithHostPinnedRedirects(att.url, fetchImpl);
      if (!res.ok) throw new Error(`download failed with HTTP ${res.status}`);

      const perAttachmentCap = Math.min(remainingBytes, limits.maxBytes);
      const bytes = await readBounded(res, perAttachmentCap);
      remainingBytes -= bytes.length;

      if (isText) {
        blocks.push({
          type: 'resource',
          resource: {
            uri: `discord-attachment:///${filename}`,
            mimeType: mime || 'text/plain',
            text: bytes.toString('utf8'),
          },
        });
      } else {
        blocks.push({
          type: 'image',
          data: bytes.toString('base64'),
          mimeType: mime,
          uri: `discord-attachment:///${filename}`,
        });
      }
    } catch (err) {
      rejected.push({ filename, reason: err.message });
    }
  }

  return { blocks, rejected };
}

export { ALLOWED_HOSTS, TEXT_EXTENSIONS, IMAGE_MIME_TYPES };
