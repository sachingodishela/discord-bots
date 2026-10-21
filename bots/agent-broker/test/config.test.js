import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, resolveRuntimeEnvironment, ConfigError } from '../src/config.js';

function baseEnv(overrides = {}) {
  return {
    DISCORD_BOT_TOKEN: 'fake-token-value',
    DISCORD_GUILD_ID: '1534099914391556228',
    DISCORD_CHANNEL_ID: '1534100366373818428',
    DISCORD_USER_ID: '710119698313773178',
    DISCORD_ROLE_ID: '1534099998214717453',
    ...overrides,
  };
}

describe('config validation', () => {
  test('loads a Discord token from an absolute credential file path', () => {
    const env = resolveRuntimeEnvironment(
      { DISCORD_BOT_TOKEN_FILE: '/run/credentials/discord-token' },
      { readFile: () => 'credential-token\n' },
    );
    assert.equal(env.DISCORD_BOT_TOKEN, 'credential-token');
  });

  test('rejects a relative Discord token file path', () => {
    assert.throws(
      () => resolveRuntimeEnvironment({ DISCORD_BOT_TOKEN_FILE: 'discord-token' }),
      ConfigError,
    );
  });

  test('loads valid config with defaults', () => {
    const cfg = loadConfig(baseEnv());
    assert.equal(cfg.discordGuildId, '1534099914391556228');
    assert.equal(cfg.maxSessions, 3);
    assert.equal(cfg.attachmentMaxBytes, 10 * 1024 * 1024);
    assert.equal(cfg.attachmentMaxCount, 5);
    assert.equal(cfg.logLevel, 'info');
    assert.equal(cfg.defaultCwd, '/home/sachin');
    assert.equal(cfg.copilotAllowAll, false);
    assert.ok(cfg.stateDir.startsWith('/'));
  });

  test('rejects missing token', () => {
    const env = baseEnv();
    delete env.DISCORD_BOT_TOKEN;
    assert.throws(() => loadConfig(env), ConfigError);
  });

  test('rejects non-snowflake guild id', () => {
    assert.throws(() => loadConfig(baseEnv({ DISCORD_GUILD_ID: 'not-a-snowflake' })), ConfigError);
  });

  test('rejects short numeric snowflake', () => {
    assert.throws(() => loadConfig(baseEnv({ DISCORD_USER_ID: '123' })), ConfigError);
  });

  test('rejects relative BROKER_DEFAULT_CWD', () => {
    assert.throws(() => loadConfig(baseEnv({ BROKER_DEFAULT_CWD: 'relative/path' })), ConfigError);
  });

  test('rejects relative COPILOT_BIN', () => {
    assert.throws(() => loadConfig(baseEnv({ COPILOT_BIN: 'copilot' })), ConfigError);
  });

  test('rejects non-positive BROKER_MAX_SESSIONS', () => {
    assert.throws(() => loadConfig(baseEnv({ BROKER_MAX_SESSIONS: '0' })), ConfigError);
  });

  test('accepts true or false for BROKER_COPILOT_ALLOW_ALL', () => {
    assert.equal(
      loadConfig(baseEnv({ BROKER_COPILOT_ALLOW_ALL: 'true' })).copilotAllowAll,
      true,
    );
    assert.equal(
      loadConfig(baseEnv({ BROKER_COPILOT_ALLOW_ALL: 'false' })).copilotAllowAll,
      false,
    );
  });

  test('rejects invalid BROKER_COPILOT_ALLOW_ALL', () => {
    assert.throws(
      () => loadConfig(baseEnv({ BROKER_COPILOT_ALLOW_ALL: 'yes' })),
      ConfigError,
    );
  });

  test('rejects invalid BROKER_LOG_LEVEL', () => {
    assert.throws(() => loadConfig(baseEnv({ BROKER_LOG_LEVEL: 'verbose' })), ConfigError);
  });

  test('accepts custom overrides', () => {
    const cfg = loadConfig(
      baseEnv({
        BROKER_STATE_DIR: '/tmp-not-used/state',
        BROKER_DEFAULT_CWD: '/home/sachin/work',
        COPILOT_BIN: '/usr/local/bin/copilot',
        BROKER_COPILOT_ALLOW_ALL: 'true',
        BROKER_MAX_SESSIONS: '5',
        BROKER_ATTACHMENT_MAX_BYTES: '2048',
        BROKER_ATTACHMENT_MAX_COUNT: '2',
        BROKER_LOG_LEVEL: 'debug',
      }),
    );
    assert.equal(cfg.maxSessions, 5);
    assert.equal(cfg.copilotAllowAll, true);
    assert.equal(cfg.attachmentMaxBytes, 2048);
    assert.equal(cfg.attachmentMaxCount, 2);
    assert.equal(cfg.logLevel, 'debug');
  });

  test('aggregates multiple issues in one error', () => {
    try {
      loadConfig({});
      assert.fail('expected throw');
    } catch (err) {
      assert.ok(err instanceof ConfigError);
      assert.ok(err.issues.length >= 4);
    }
  });
});
