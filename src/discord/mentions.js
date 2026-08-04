/**
 * Pure functions for Discord message admission and mention/role parsing.
 * No I/O; fully unit-testable.
 */

/**
 * @param {object} message Discord message object
 * @param {string} botUserId
 * @returns {boolean}
 */
export function isBotMentioned(message, botUserId) {
  return Array.isArray(message.mentions) && message.mentions.some((u) => u.id === botUserId);
}

/**
 * @param {object} message
 * @param {string} roleId
 * @returns {boolean}
 */
export function isRoleMentioned(message, roleId) {
  return Array.isArray(message.mention_roles) && message.mention_roles.includes(roleId);
}

/**
 * Strips a leading/trailing bot mention token (<@id> or <@!id>) and role
 * mention token (<@&id>) from content and returns the trimmed remainder.
 * @param {string} content
 * @param {string} botUserId
 * @param {string} [roleId]
 * @returns {string}
 */
export function stripMentions(content, botUserId, roleId) {
  let out = content;
  const botRe = new RegExp(`<@!?${botUserId}>`, 'g');
  out = out.replace(botRe, ' ');
  if (roleId) {
    const roleRe = new RegExp(`<@&${roleId}>`, 'g');
    out = out.replace(roleRe, ' ');
  }
  return out.replace(/\s+/g, ' ').trim();
}

/**
 * Determines whether a top-level (non-thread) message triggers a new
 * Copilot session: requires a direct bot mention OR the configured role
 * mention, AND a non-empty remaining prompt after stripping mentions.
 * @param {object} message
 * @param {{botUserId:string, roleId:string}} cfg
 * @returns {{trigger:boolean, prompt:string}}
 */
export function evaluateTopLevelTrigger(message, cfg) {
  const mentioned = isBotMentioned(message, cfg.botUserId) || isRoleMentioned(message, cfg.roleId);
  if (!mentioned) return { trigger: false, prompt: '' };
  const prompt = stripMentions(message.content || '', cfg.botUserId, cfg.roleId);
  return { trigger: prompt.length > 0, prompt };
}

/**
 * Full admission check for an incoming MESSAGE_CREATE.
 * @param {object} message
 * @param {{guildId:string, channelId:string, userId:string, botUserId:string}} cfg
 * @param {{isKnownThread:(id:string)=>boolean}} threadLookup
 * @returns {{admitted:boolean, reason?:string, isThreadFollowUp?:boolean}}
 */
export function admitMessage(message, cfg, threadLookup) {
  if (message.author?.bot) return { admitted: false, reason: 'bot-author' };
  if (message.author?.id !== cfg.userId) return { admitted: false, reason: 'wrong-user' };
  if (!message.guild_id) return { admitted: false, reason: 'dm' };
  if (message.guild_id !== cfg.guildId) return { admitted: false, reason: 'wrong-guild' };

  const inKnownThread = threadLookup.isKnownThread(message.channel_id);
  if (inKnownThread) {
    return { admitted: true, isThreadFollowUp: true };
  }

  if (message.channel_id !== cfg.channelId) {
    return { admitted: false, reason: 'wrong-channel' };
  }

  return { admitted: true, isThreadFollowUp: false };
}
