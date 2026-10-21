import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  isBotMentioned,
  isRoleMentioned,
  stripMentions,
  evaluateTopLevelTrigger,
  admitMessage,
} from '../src/discord/mentions.js';

const BOT_ID = '999000111222333444';
const ROLE_ID = '1534099998214717453';
const GUILD_ID = '1534099914391556228';
const CHANNEL_ID = '1534100366373818428';
const USER_ID = '710119698313773178';

function makeMessage(overrides = {}) {
  return {
    id: 'msg-1',
    content: '',
    author: { id: USER_ID, bot: false },
    guild_id: GUILD_ID,
    channel_id: CHANNEL_ID,
    mentions: [],
    mention_roles: [],
    ...overrides,
  };
}

describe('mention parsing', () => {
  test('detects direct bot mention', () => {
    const msg = makeMessage({ mentions: [{ id: BOT_ID }] });
    assert.ok(isBotMentioned(msg, BOT_ID));
  });

  test('detects role mention', () => {
    const msg = makeMessage({ mention_roles: [ROLE_ID] });
    assert.ok(isRoleMentioned(msg, ROLE_ID));
  });

  test('strips bot and role mention tokens', () => {
    const stripped = stripMentions(`<@${BOT_ID}> <@&${ROLE_ID}> hello world`, BOT_ID, ROLE_ID);
    assert.equal(stripped, 'hello world');
  });

  test('strips nickname-style mention <@!id>', () => {
    const stripped = stripMentions(`<@!${BOT_ID}> do the thing`, BOT_ID, ROLE_ID);
    assert.equal(stripped, 'do the thing');
  });
});

describe('evaluateTopLevelTrigger', () => {
  test('triggers on bot mention with remaining prompt', () => {
    const msg = makeMessage({ content: `<@${BOT_ID}> hello there`, mentions: [{ id: BOT_ID }] });
    const result = evaluateTopLevelTrigger(msg, { botUserId: BOT_ID, roleId: ROLE_ID });
    assert.equal(result.trigger, true);
    assert.equal(result.prompt, 'hello there');
  });

  test('triggers on role mention with remaining prompt', () => {
    const msg = makeMessage({ content: `<@&${ROLE_ID}> please help`, mention_roles: [ROLE_ID] });
    const result = evaluateTopLevelTrigger(msg, { botUserId: BOT_ID, roleId: ROLE_ID });
    assert.equal(result.trigger, true);
  });

  test('does not trigger without any mention', () => {
    const msg = makeMessage({ content: 'hello there' });
    const result = evaluateTopLevelTrigger(msg, { botUserId: BOT_ID, roleId: ROLE_ID });
    assert.equal(result.trigger, false);
  });

  test('does not trigger when mention present but prompt is empty', () => {
    const msg = makeMessage({ content: `<@${BOT_ID}>`, mentions: [{ id: BOT_ID }] });
    const result = evaluateTopLevelTrigger(msg, { botUserId: BOT_ID, roleId: ROLE_ID });
    assert.equal(result.trigger, false);
  });
});

describe('admitMessage', () => {
  const cfg = { guildId: GUILD_ID, channelId: CHANNEL_ID, userId: USER_ID, botUserId: BOT_ID };
  const noKnownThreads = { isKnownThread: () => false };

  test('rejects bot authors', () => {
    const msg = makeMessage({ author: { id: USER_ID, bot: true } });
    const result = admitMessage(msg, cfg, noKnownThreads);
    assert.equal(result.admitted, false);
    assert.equal(result.reason, 'bot-author');
  });

  test('rejects wrong user', () => {
    const msg = makeMessage({ author: { id: '1111111111111111', bot: false } });
    const result = admitMessage(msg, cfg, noKnownThreads);
    assert.equal(result.admitted, false);
    assert.equal(result.reason, 'wrong-user');
  });

  test('rejects DMs (no guild_id)', () => {
    const msg = makeMessage({ guild_id: undefined });
    const result = admitMessage(msg, cfg, noKnownThreads);
    assert.equal(result.admitted, false);
    assert.equal(result.reason, 'dm');
  });

  test('rejects other guilds', () => {
    const msg = makeMessage({ guild_id: '1111111111111111' });
    const result = admitMessage(msg, cfg, noKnownThreads);
    assert.equal(result.admitted, false);
    assert.equal(result.reason, 'wrong-guild');
  });

  test('rejects other channels when not a known thread', () => {
    const msg = makeMessage({ channel_id: '2222222222222222' });
    const result = admitMessage(msg, cfg, noKnownThreads);
    assert.equal(result.admitted, false);
    assert.equal(result.reason, 'wrong-channel');
  });

  test('admits top-level channel message for further trigger evaluation', () => {
    const msg = makeMessage();
    const result = admitMessage(msg, cfg, noKnownThreads);
    assert.equal(result.admitted, true);
    assert.equal(result.isThreadFollowUp, false);
  });

  test('admits known-thread follow-up without mention or channel match', () => {
    const msg = makeMessage({ channel_id: 'thread-123' });
    const result = admitMessage(msg, cfg, { isKnownThread: (id) => id === 'thread-123' });
    assert.equal(result.admitted, true);
    assert.equal(result.isThreadFollowUp, true);
  });
});
