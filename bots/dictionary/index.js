import { Client, GatewayIntentBits, EmbedBuilder } from 'discord.js';
import { GoogleGenAI } from '@google/genai';
import 'dotenv/config';

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

async function fetchFromDictionaryApi(word) {
  try {
    const res = await fetch(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word)}`);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function fetchFromGemini(word) {
  try {
    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: `Provide a concise dictionary definition for "${word}". Format your response with:
1. Part of speech & pronunciation
2. Core definition(s). (Definition: <definition>)
3. 2-3 example sentences (Examples: 1. 2. 3.)
Keep it direct and compact for a chat message.`,
    });
    return response.text;
  } catch (err) {
    console.error('Gemini error:', err);
    return null;
  }
}

client.on('messageCreate', async (message) => {
  // Ignore bots and enforce channel lockdown
  if (message.author.bot) return;
  if (process.env.DICT_CHANNEL_ID && message.channel.id !== process.env.DICT_CHANNEL_ID) return;

  // Check if the bot was directly mentioned in the message
  const botMentionRegex = new RegExp(`^<@!?${client.user.id}>`);
  const isMentioned = botMentionRegex.test(message.content.trim());

  // Also allow "!def" as an alternative trigger
  const hasPrefix = message.content.trim().startsWith('!def ');

  if (!isMentioned && !hasPrefix) return;

  // Strip the bot mention or prefix to isolate the word
  const word = message.content
    .replace(botMentionRegex, '')
    .replace(/^!def\s+/, '')
    .trim()
    .toLowerCase();

  if (!word) {
    return message.reply('Please specify a word to look up (e.g., `@BotName serendipity`).');
  }

  await message.channel.sendTyping();

  // 1. Try Free Dictionary API
  const dictData = await fetchFromDictionaryApi(word);

  if (dictData && dictData.length > 0) {
    const entry = dictData[0];
    const phonetic = entry.phonetic || entry.phonetics?.find((p) => p.text)?.text || '';

    const embed = new EmbedBuilder()
      .setTitle(`${entry.word} ${phonetic ? `[${phonetic}]` : ''}`)
      .setColor(0x5865F2);

    entry.meanings.slice(0, 2).forEach((meaning) => {
      const defs = meaning.definitions
        .slice(0, 2)
        .map((d, i) => `${i + 1}. ${d.definition}${d.example ? `\n   *"${d.example}"*` : ''}`)
        .join('\n');
      embed.addFields({ name: meaning.partOfSpeech, value: defs });
    });

    return message.reply({ embeds: [embed] });
  }

  // 2. Fall back to Gemini API
  const aiDefinition = await fetchFromGemini(word);
  if (aiDefinition) {
    const embed = new EmbedBuilder()
      .setTitle(word)
      .setDescription(aiDefinition)
      .setFooter({ text: 'Powered by Gemini' })
      .setColor(0x2ECC71);

    return message.reply({ embeds: [embed] });
  }

  message.reply(`Could not find a definition for **${word}**.`);
});

client.once('ready', () => {
  console.log(`Dictionary bot online as ${client.user.tag}`);
});

client.login(process.env.DISCORD_TOKEN);