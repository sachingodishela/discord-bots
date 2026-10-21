# Discord Bots

Independent Discord bots in one repository. Each bot owns its source,
dependencies, Dockerfile, README, and environment configuration under `bots/<name>/`.
The root `compose.yaml` manages their containers.

## Available bots

| Bot | Directory | Description |
| --- | --- | --- |
| [Dictionary](bots/dictionary/README.md) | `bots/dictionary` | Dictionary lookups using the Free Dictionary API with a Gemini fallback. |
| [Agent Broker](bots/agent-broker/README.md) | `bots/agent-broker` | Bridges Discord threads to GitHub Copilot CLI sessions over ACP, one session per thread. |

## Run with Docker

Install Docker Engine and Docker Compose, then follow the relevant bot's README
for credentials, Discord configuration, startup, and script updates.
Run all Docker Compose commands from the repository root.
Real `.env` files are ignored by Git and excluded from Docker images; only
placeholder `.env.reference` files belong in the repository.

Services use `restart: unless-stopped`: Docker restarts them after process exits
and Docker daemon restarts, but not after a manual stop. Enable the Docker service
at boot for startup after a host reboot. Caught errors that leave a process
running do not trigger a restart.

## Adding a bot

Create `bots/<name>/` with its own source, dependency manifest and lockfile,
Dockerfile, `.dockerignore`, and `.env.reference` containing placeholders only.
Include a bot-specific README covering configuration, usage, local development,
and Docker startup, logs, stopping, and deployment after script updates.
Keep its Docker build context inside that directory and exclude `.env` and
`.env.*` in its `.dockerignore`.

Add a service to the root `compose.yaml` using the dictionary service as a
starting point (see the agent-broker service for persistent named volumes). Set `build: ./bots/<name>`, set `env_file` to
`./bots/<name>/.env`, and retain the restart policy, init process, and log limits.
Use a separate Discord application/token for each bot. Add it to the table
above with a link to its README, create its local `.env`, and run
`docker compose up -d --build <name>`.

Bots are built and restarted independently; adding one does not require changing
the dictionary bot or sharing its dependencies.
