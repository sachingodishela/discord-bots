/**
 * Guild-scoped Discord slash command definitions and interaction admission.
 */

/** Discord application command definitions, registered via PUT on READY. */
export const COMMAND_DEFINITIONS = [
  { name: 'cancel', description: 'Cancel the current prompt and any pending approvals in this thread', type: 1 },
  { name: 'reset', description: 'Reset this thread: closes the Copilot session so the next message starts fresh', type: 1 },
  { name: 'status', description: 'Show broker/session status for this thread', type: 1 },
];

const INTERACTION_TYPE = { PING: 1, APPLICATION_COMMAND: 2, MESSAGE_COMPONENT: 3 };
const CALLBACK_TYPE = {
  PONG: 1,
  CHANNEL_MESSAGE_WITH_SOURCE: 4,
  DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE: 5,
  UPDATE_MESSAGE: 7,
};
const EPHEMERAL_FLAG = 1 << 6;

/**
 * Validates that an interaction originates from the configured guild/user
 * and from an admitted channel: either the configured top-level channel or
 * a thread channel we know about.
 * @param {object} interaction
 * @param {{guildId:string, userId:string, channelId:string, isKnownThread:(id:string)=>boolean}} cfg
 * @returns {{ok:boolean, reason?:string}}
 */
export function validateInteraction(interaction, cfg) {
  const invokingUserId = interaction.member?.user?.id || interaction.user?.id;
  if (interaction.guild_id !== cfg.guildId) return { ok: false, reason: 'wrong-guild' };
  if (invokingUserId !== cfg.userId) return { ok: false, reason: 'wrong-user' };
  const channelId = interaction.channel_id;
  const channelOk = channelId === cfg.channelId || cfg.isKnownThread(channelId);
  if (!channelOk) return { ok: false, reason: 'wrong-channel' };
  return { ok: true };
}

/** @param {string} content @returns {object} ephemeral CHANNEL_MESSAGE_WITH_SOURCE response body */
export function ephemeralResponse(content) {
  return {
    type: CALLBACK_TYPE.CHANNEL_MESSAGE_WITH_SOURCE,
    data: { content, flags: EPHEMERAL_FLAG },
  };
}

/**
 * @returns {object} deferred ephemeral response body (ACKs the interaction
 * immediately; the actual content is sent later via an edit of the original
 * response). Used for commands whose work may exceed Discord's 3-second
 * interaction callback deadline (e.g. `/reset`).
 */
export function deferredEphemeralResponse() {
  return {
    type: CALLBACK_TYPE.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
    data: { flags: EPHEMERAL_FLAG },
  };
}

/** @returns {object} PONG response body for gateway-delivered PING interactions */
export function pongResponse() {
  return { type: CALLBACK_TYPE.PONG };
}

export { INTERACTION_TYPE, CALLBACK_TYPE, EPHEMERAL_FLAG };
