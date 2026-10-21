# Dictionary Bot

Looks up words using the Free Dictionary API, with Gemini as a fallback.
Use `!def word` or mention the bot at the start of a message: `@BotName word`.

See the [repository README](../../README.md) for the multi-bot layout and shared
Docker restart behavior.

## Configuration

Create a Discord bot in the Discord Developer Portal, enable its Message Content
Intent, and invite it to your server with permissions to view its channels, send
messages, and embed links. Obtain a Gemini API key from Google AI Studio.

From the repository root:

```sh
cp -n bots/dictionary/.env.reference bots/dictionary/.env
```

Edit `bots/dictionary/.env` with these values before starting:

| Variable | Required | Description |
| --- | --- | --- |
| `DISCORD_TOKEN` | Yes | Discord bot token. |
| `GEMINI_API_KEY` | Yes | Gemini API key for fallback definitions. |
| `DICT_CHANNEL_ID` | No | Restrict replies to this channel; leave empty to allow any accessible channel. |

Keep real credentials in the local `.env`, never in `.env.reference`.

## Run with Docker

Run all Compose commands below from the repository root. Stop any existing copy
running directly with Node first to avoid duplicate bot replies.

```sh
# Build and start
docker compose up -d --build dictionary

# Follow logs
docker compose logs -f dictionary

# Stop
docker compose stop dictionary

# Start again
docker compose up -d dictionary
```

The container runs `node index.js` as a non-root user, loads `.env` at runtime,
and automatically restarts unless manually stopped.

## Deploying future script updates

After editing `bots/dictionary/index.js` or its dependencies, run this from the
repository root to rebuild the image and recreate the container with your changes:

```sh
docker compose up -d --build dictionary
```

A plain `docker compose restart` does not pick up script changes because the
source is copied into the image at build time.

## Local development

With the `.env` configured and the Docker copy stopped, run from the repository
root:

```sh
cd bots/dictionary
npm ci
npm run check
npm start
```
