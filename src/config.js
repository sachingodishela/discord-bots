/**
 * Configuration loading and validation.
 *
 * All runtime configuration comes from environment variables. Nothing here
 * ever logs secret values (the bot token) - only presence/absence.
 */
import { readFileSync } from 'node:fs';

/** Error thrown when configuration is invalid. Message is safe to log. */
export class ConfigError extends Error {
  constructor(issues) {
    super(`Invalid configuration:\n- ${issues.join('\n- ')}`);
    this.name = 'ConfigError';
    this.issues = issues;
  }
}

const SNOWFLAKE_RE = /^[0-9]{17,20}$/;
const LOG_LEVELS = new Set(['debug', 'info', 'warn', 'error']);

/**
 * Loads a Discord token from a systemd credential or another protected file
 * when DISCORD_BOT_TOKEN is not set directly.
 * @param {NodeJS.ProcessEnv} [env]
 * @param {{readFile?: typeof readFileSync}} [opts]
 * @returns {NodeJS.ProcessEnv}
 */
export function resolveRuntimeEnvironment(env = process.env, opts = {}) {
  const resolved = { ...env };
  if (resolved.DISCORD_BOT_TOKEN || !resolved.DISCORD_BOT_TOKEN_FILE) {
    return resolved;
  }

  if (!resolved.DISCORD_BOT_TOKEN_FILE.startsWith('/')) {
    throw new ConfigError(['DISCORD_BOT_TOKEN_FILE must be an absolute path']);
  }

  try {
    resolved.DISCORD_BOT_TOKEN = (opts.readFile || readFileSync)(
      resolved.DISCORD_BOT_TOKEN_FILE,
      'utf8',
    ).trim();
  } catch (err) {
    throw new ConfigError([
      `DISCORD_BOT_TOKEN_FILE could not be read: ${err.code || err.name || 'unknown error'}`,
    ]);
  }
  return resolved;
}

/**
 * @param {string} name
 * @param {string|undefined} value
 * @param {string[]} issues
 * @returns {string|null}
 */
function requireSnowflake(name, value, issues) {
  if (value === undefined || value === '') {
    issues.push(`${name} is required`);
    return null;
  }
  if (!SNOWFLAKE_RE.test(value)) {
    issues.push(`${name} must be a decimal snowflake (17-20 digits)`);
    return null;
  }
  return value;
}

/**
 * @param {string} name
 * @param {string} value
 * @param {string[]} issues
 * @returns {string|null}
 */
function requireAbsolutePath(name, value, issues) {
  if (!value || typeof value !== 'string' || value[0] !== '/') {
    issues.push(`${name} must be an absolute path`);
    return null;
  }
  return value;
}

/**
 * @param {string} name
 * @param {string|undefined} value
 * @param {number} fallback
 * @param {string[]} issues
 * @returns {number}
 */
function positiveInt(name, value, fallback, issues) {
  if (value === undefined || value === '') return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    issues.push(`${name} must be a positive integer`);
    return fallback;
  }
  return n;
}

/**
 * @param {string} name
 * @param {string|undefined} value
 * @param {boolean} fallback
 * @param {string[]} issues
 * @returns {boolean}
 */
function booleanValue(name, value, fallback, issues) {
  if (value === undefined || value === '') return fallback;
  if (value === 'true') return true;
  if (value === 'false') return false;
  issues.push(`${name} must be true or false`);
  return fallback;
}

/**
 * Loads and validates configuration from an environment-like object.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Readonly<object>}
 */
export function loadConfig(env = process.env) {
  const issues = [];

  const token = env.DISCORD_BOT_TOKEN;
  if (!token || typeof token !== 'string' || token.trim() === '') {
    issues.push('DISCORD_BOT_TOKEN is required');
  }

  const guildId = requireSnowflake('DISCORD_GUILD_ID', env.DISCORD_GUILD_ID, issues);
  const channelId = requireSnowflake('DISCORD_CHANNEL_ID', env.DISCORD_CHANNEL_ID, issues);
  const userId = requireSnowflake('DISCORD_USER_ID', env.DISCORD_USER_ID, issues);
  const roleId = requireSnowflake('DISCORD_ROLE_ID', env.DISCORD_ROLE_ID, issues);

  const stateDir = requireAbsolutePath(
    'BROKER_STATE_DIR',
    env.BROKER_STATE_DIR || '/home/sachin/.local/state/discord-copilot-broker',
    issues,
  );

  const defaultCwd = requireAbsolutePath(
    'BROKER_DEFAULT_CWD',
    env.BROKER_DEFAULT_CWD || '/home/sachin',
    issues,
  );

  const copilotBin = requireAbsolutePath(
    'COPILOT_BIN',
    env.COPILOT_BIN || '/home/sachin/.nvm/versions/node/v24.18.1/bin/copilot',
    issues,
  );

  const maxSessions = positiveInt('BROKER_MAX_SESSIONS', env.BROKER_MAX_SESSIONS, 3, issues);
  const copilotAllowAll = booleanValue(
    'BROKER_COPILOT_ALLOW_ALL',
    env.BROKER_COPILOT_ALLOW_ALL,
    false,
    issues,
  );
  const attachmentMaxBytes = positiveInt(
    'BROKER_ATTACHMENT_MAX_BYTES',
    env.BROKER_ATTACHMENT_MAX_BYTES,
    10 * 1024 * 1024,
    issues,
  );
  const attachmentMaxCount = positiveInt(
    'BROKER_ATTACHMENT_MAX_COUNT',
    env.BROKER_ATTACHMENT_MAX_COUNT,
    5,
    issues,
  );

  const logLevel = env.BROKER_LOG_LEVEL || 'info';
  if (!LOG_LEVELS.has(logLevel)) {
    issues.push(`BROKER_LOG_LEVEL must be one of ${[...LOG_LEVELS].join(', ')}`);
  }

  if (issues.length > 0) {
    throw new ConfigError(issues);
  }

  return Object.freeze({
    discordBotToken: token,
    discordGuildId: guildId,
    discordChannelId: channelId,
    discordUserId: userId,
    discordRoleId: roleId,
    stateDir,
    defaultCwd,
    copilotBin,
    copilotAllowAll,
    maxSessions,
    attachmentMaxBytes,
    attachmentMaxCount,
    logLevel,
  });
}
