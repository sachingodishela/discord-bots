# Discord Bots

Independent Discord bots in one repository. Each bot owns its source,
dependencies, Dockerfile, and environment configuration under `bots/<name>/`.
The root `compose.yaml` manages their containers.

## Available bots

| Bot | Directory | Description |
| --- | --- | --- |
| Dictionary | `bots/dictionary` | Dictionary lookups using the Free Dictionary API with a Gemini fallback. Trigger with `!def word` or `@BotName word`. |

## Run with Docker

Install Docker Engine and Docker Compose. Run these commands from the repository
root, then fill in `DISCORD_TOKEN`, `GEMINI_API_KEY`, and optionally
`DICT_CHANNEL_ID` in `bots/dictionary/.env` before starting the bot.
Enable the Message Content Intent for the bot in the Discord Developer Portal.
Real `.env` files are ignored by Git and excluded from Docker images; only
placeholder `.env.reference` files belong in the repository.

```sh
cp -n bots/dictionary/.env.reference bots/dictionary/.env
# Edit bots/dictionary/.env with your credentials before starting.
docker compose up -d --build dictionary
```

The container runs `node index.js` as a non-root user. Docker restarts it when
the process exits, including on errors, and after a Docker daemon restart.
After a manual stop, it stays stopped until you start it again.
Enable the Docker service at boot for automatic startup after a host reboot.
Caught errors that leave the process running do not trigger a restart.

```sh
# Follow logs
docker compose logs -f dictionary

# Stop the bot
docker compose stop dictionary

# Start it again
docker compose up -d dictionary

# Rebuild after code or dependency changes
docker compose up -d --build dictionary
```

Stop any existing copy running directly with Node before starting the container
to avoid duplicate bot replies.

## Local development

```sh
cd bots/dictionary
npm ci
npm run check
npm start
```

## Adding a bot

Create `bots/<name>/` with its own source, dependency manifest and lockfile,
Dockerfile, `.dockerignore`, and `.env.reference` containing placeholders only.
Keep its Docker build context inside that directory and exclude `.env` and
`.env.*` in its `.dockerignore`.

Add a service to the root `compose.yaml` using the dictionary service as a
starting point. Set `build: ./bots/<name>`, set `env_file` to
`./bots/<name>/.env`, and retain the restart policy, init process, and log limits.
Use a separate Discord application/token for each bot. Add it to the table
above, create its local `.env`, and run `docker compose up -d --build <name>`.

Bots are built and restarted independently; adding one does not require changing
the dictionary bot or sharing its dependencies.
