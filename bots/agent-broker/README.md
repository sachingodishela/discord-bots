# Agent Broker Bot

A dependency-free Node.js broker that bridges a Discord bot to the
[Copilot CLI](https://github.com/github/copilot-cli) over its Agent Client
Protocol (ACP) stdio interface. One Discord thread maps to exactly one
Copilot ACP session/process.

Zero third-party npm runtime or dev dependencies: only Node.js built-ins
(`node:*`) plus the global `WebSocket` and `fetch` APIs available in modern
Node. Plain ESM JavaScript, no TypeScript/transpilation.

See the [repository README](../../README.md) for the multi-bot layout and shared
Docker restart behavior.

## Architecture

```
src/
  config.js              env var loading + validation
  logger.js               structured JSON logger, secret-safe
  state/store.js          atomic JSON state store (gateway resume + thread map)
  discord/
    rest.js               Discord REST client (serialized, 429-aware)
    gateway.js             Discord Gateway v10 client (WebSocket)
    mentions.js             mention/role/thread/user admission (pure functions)
    commands.js             slash command defs + interaction admission
    streaming.js            throttled streaming reply / message splitting
    attachments.js           attachment validation + ACP content-block conversion
  acp/
    ndjson.js               NDJSON framing (encode/decode)
    client.js                ACP stdio JSON-RPC client (spawns `copilot --acp --stdio`)
    permissions.js            session/request_permission -> Discord buttons bridge
  broker.js                orchestrates all of the above
  index.js                  entry point, config/logger/state wiring, signal handlers
```

Each module is independently unit-testable and (aside from `broker.js`, the
orchestrator) has no dependency on Discord or ACP wire formats beyond its own
narrow concern.

## Threat model / trust boundaries

- **The broker and every Copilot ACP session it spawns run inside one Docker
  container as the non-root `node` user.** Copilot can read/write anything in
  the container, including the shared `/workspace` volume, but not the host
  filesystem. Multiple threads' sessions **share the same container
  filesystem** even though each has an independent Copilot session id and
  child process — a change made from one thread's session is visible to every
  other thread's session.
- **The only enforced identity boundary is Discord-side authorization**:
  the configured Discord guild, channel, user, and role IDs. Anyone who
  controls that Discord account, or who compromises the bot token, has the
  same level of access to the container (and the network and GitHub token
  it holds) as the broker process does.
- **Secrets are never logged or persisted.** The Discord bot token, Discord
  interaction tokens, GitHub/Copilot auth data, prompt/message content, and
  attachment bytes are excluded from the structured logger and from the
  on-disk state file by construction — see `src/logger.js` (key/value
  redaction) and `src/state/store.js` (explicit allow-listed fields only).
  Note that child Copilot processes inherit the container environment,
  including `COPILOT_GITHUB_TOKEN`.
- **ACP permission requests are a UX surface, not a security control.** The
  bridge for `session/request_permission` (see below) makes the agent's own
  tool-call approval flow visible in Discord; it does not itself sandbox or
  restrict what the agent can request.

## Environment variables

| Variable | Required | Default | Notes |
|---|---|---|---|
| `DISCORD_BOT_TOKEN` | conditionally | — | Required unless `DISCORD_BOT_TOKEN_FILE` is set. Never logged. |
| `DISCORD_BOT_TOKEN_FILE` | conditionally | — | Absolute path to a protected token file (e.g. a mounted secret). |
| `COPILOT_GITHUB_TOKEN` | yes (Docker) | — | GitHub token with Copilot access, read by the Copilot CLI (fine-grained PAT with "Copilot Requests", or a `gh auth token` OAuth token). |
| `DISCORD_GUILD_ID` | yes | — | Decimal snowflake, 17-20 digits. |
| `DISCORD_CHANNEL_ID` | yes | — | Top-level trigger channel. Decimal snowflake. |
| `DISCORD_USER_ID` | yes | — | The only user the broker will respond to. Decimal snowflake. |
| `DISCORD_ROLE_ID` | yes | — | Role mention that also triggers a new session. Decimal snowflake. |
| `BROKER_STATE_DIR` | no | `/data/state` | Must be absolute. Created with mode `0700`. Backed by the `agent-broker-state` volume. |
| `BROKER_DEFAULT_CWD` | no | `/workspace` | Must be absolute. Default cwd for new Copilot sessions. Backed by the `agent-broker-workspace` volume. |
| `COPILOT_BIN` | no | `/usr/local/bin/copilot` | Must be absolute. Installed in the image (`COPILOT_VERSION` build arg). |
| `BROKER_COPILOT_ALLOW_ALL` | no | `false` | When `true`, broker sessions start Copilot with `--allow-all`, disabling tool/path/URL prompts. |
| `BROKER_MAX_SESSIONS` | no | `3` | Positive integer; caps concurrent Copilot processes. |
| `BROKER_ATTACHMENT_MAX_BYTES` | no | `10485760` (10 MiB) | Total budget shared across all attachments in one message. |
| `BROKER_ATTACHMENT_MAX_COUNT` | no | `5` | Max attachments per message. |
| `BROKER_LOG_LEVEL` | no | `info` | One of `debug`, `info`, `warn`, `error`. |

## Configuration

Create a Discord application/bot in the Discord Developer Portal, enable its
Message Content Intent, and invite it with permissions to view channels, send
messages, create public threads, send messages in threads, and manage threads.

From the repository root:

```sh
cp -n bots/agent-broker/.env.reference bots/agent-broker/.env
chmod 600 bots/agent-broker/.env
```

Fill in the values above. Keep real credentials in the local `.env`, never in
`.env.reference`.

## Run with Docker

Run all Compose commands from the repository root. Only one copy of the broker
may run per Discord token.

```sh
# Build and start
docker compose up -d --build agent-broker

# Follow logs (structured JSON)
docker compose logs -f agent-broker

# Stop (the broker gets 30s to close Copilot sessions)
docker compose stop agent-broker

# Start again
docker compose up -d agent-broker
```

The container runs `node src/index.js` as the non-root `node` user, loads
`.env` at runtime, and automatically restarts unless manually stopped. Named
volumes persist data across rebuilds:

| Volume | Mount | Contents |
| --- | --- | --- |
| `agent-broker-state` | `/data/state` | Gateway resume data and thread-to-session map. |
| `agent-broker-copilot` | `/home/node/.copilot` | Copilot CLI config and session history (needed for `session/resume`). |
| `agent-broker-workspace` | `/workspace` | Default working directory for Copilot sessions. |

The image includes `git`, `curl`, and `ripgrep` for Copilot tool use. To bump
the Copilot CLI, change `COPILOT_VERSION` in the `Dockerfile` and rebuild.

## Deploying future script updates

After editing anything under `bots/agent-broker/src/`, rebuild and recreate:

```sh
docker compose up -d --build agent-broker
```

A plain `docker compose restart` does not pick up script changes because the
source is copied into the image at build time.

## Local development

With the Docker copy stopped, from `bots/agent-broker`:

```sh
set -a; source .env; set +a
export BROKER_STATE_DIR=$PWD/.local-state BROKER_DEFAULT_CWD=$PWD COPILOT_BIN=$(command -v copilot)
npm start
```

The process logs structured JSON to stdout and exits non-zero with a clear
message if configuration is invalid or the state file is corrupt (state
corruption is never silently discarded — see below).

To smoke-test Copilot ACP inside the image without connecting to Discord:

```sh
docker compose run --rm --no-deps \
  -v ./bots/agent-broker/scripts:/app/scripts:ro agent-broker node scripts/smoke-acp.mjs
```

## Offline tests

```sh
npm test    # node --test test/*.test.js — no network access required
```

All ~95 tests run fully offline: the Discord REST/Gateway clients are
exercised against in-memory fakes/a fake `WebSocket`, the ACP client is
exercised against a real child process spawned from
`test/fixtures/mock-acp-agent.js` (a small NDJSON JSON-RPC stub, not the
real Copilot binary), and `fetch` for attachment downloads is mocked.
Test scratch directories live under `test/.scratch/` (git-ignored, cleaned
up per test) — nothing is written outside the repository.

## Discord flow

1. **Top-level trigger**: in the configured channel, the configured user
   posts a message that either @-mentions the bot directly or mentions the
   configured role, with non-empty remaining text after stripping the
   mention(s). This creates one new public Discord thread from that message
   and spawns one Copilot ACP session/process for it.
2. **Thread follow-ups**: once a thread is "known" (tracked in state), the
   configured user can post follow-up messages in that thread with no
   mention required. Other guilds/channels/users/DMs/bots are ignored.
3. **Streaming replies**: the broker posts a placeholder message, then
   edits it roughly every 1.5s as the agent streams `agent_message_chunk`
   updates, plus compact one-line tool-call status updates (never raw tool
   output). Replies are split across multiple sequential messages if they
   would exceed Discord's 2000-character limit, without losing content.
4. **Attachments**: up to `BROKER_ATTACHMENT_MAX_COUNT` attachments and
   `BROKER_ATTACHMENT_MAX_BYTES` total bytes per message, fetched only from
   `cdn.discordapp.com`/`media.discordapp.net` over HTTPS (redirects are
   pinned to the same host allowlist). Text-like files are embedded as ACP
   `resource` text blocks; PNG/JPEG/GIF/WebP images become ACP `image`
   blocks only if the agent capability advertises image support. Anything
   else, oversized, or off-host is rejected with an explicit Discord
   message. Attachments are never written to the host filesystem.

## Commands

Guild-scoped slash commands, registered on Gateway `READY`:

- `/status` — reports cwd, busy/idle, and a shortened Copilot session id for
  the current thread (never secrets). Works in the top-level channel too
  (reports "not a known thread").
- `/cancel` — sends `session/cancel` to the thread's active Copilot session
  and resolves any pending permission requests in that thread as cancelled.
- `/delete` — closes the Copilot process, permanently removes the stored
  session mapping, and deletes the Discord thread. It is rejected in the
  top-level channel.
- `/reset` — closes (or kills) the thread's Copilot child process and
  clears its stored session id. The thread stays "known" (no mention
  needed for the next message), but that next message starts a **brand
  new** Copilot session.

All three validate the invoking user, guild, and channel (top-level channel
or a known thread) and respond ephemerally within Discord's 3-second
interaction window.

## Session semantics and shared-filesystem warning

- One Discord thread ⇄ one Copilot ACP session/process, for the lifetime of
  that mapping.
- **All sessions run as the same container user against the same container filesystem.**
  There is no per-thread chroot, container, or filesystem isolation. Two
  threads working in the same directory can observe and clobber each
  other's file changes. This is a deliberate, documented limitation, not an
  oversight — do not treat separate threads as a security boundary.
- **Restart / restore policy**: on startup, thread-to-session mappings are
  restored lazily (on that thread's first post-restart message), not
  eagerly. The broker spawns a fresh Copilot process, calls `initialize`,
  then attempts `session/resume` (falling back to `session/load` if the
  agent doesn't support resume). If that fails for any reason, the broker
  **does not** silently start a new session and discard context. It posts
  an explicit message explaining that restoration failed and instructs the
  user to run `/reset` to start over deliberately. This is intentional:
  losing conversation context is a user-visible decision, never a silent
  side effect.

## Permission workflow

When the Copilot agent sends a `session/request_permission` reverse
request, the broker posts a message in the owning thread showing a
sanitized tool title/kind and a bounded, JSON-formatted `rawInput` preview
(secret-shaped values best-effort redacted, size-capped), with exactly two
buttons: **Allow Once** and **Reject**. `allow_always`/`reject_always` are
intentionally never offered in this version, to avoid silently granting
blanket standing permission from a single click.

Each button's `custom_id` embeds a single-use, cryptographically random
nonce that is bound in memory (never persisted) to the exact pending
request, the originating thread, and the operator's Discord user id. A
click is honored only if: it comes from the configured operator user, in
the same thread, on the same message (once known), has not already been
used, and arrives within 5 minutes of the request being posted. Stale,
replayed, cross-thread, or wrong-user clicks are rejected without
resolving the pending request. On timeout or `/cancel`, the ACP response is
`{outcome:{outcome:'cancelled'}}`; on a valid click it is exactly
`{outcome:{outcome:'selected',optionId:<id>}}`. The approval message is
updated in place afterward without ever exposing the interaction token.

When `BROKER_COPILOT_ALLOW_ALL=true` (the `.env.reference` default),
broker-launched Copilot processes bypass this approval workflow entirely.
This only affects Copilot inside the container.

## Known limitations

- No per-thread sandboxing of Copilot child processes: see
  "shared-filesystem warning" above. The container is the only isolation
  boundary.
- The Discord REST client serializes all requests through a single queue;
  this is simple and correct but not maximally throughput-optimized (fine
  for a single-guild, single-operator bot).
- `available_commands_update`/`usage_update` ACP session updates are
  observed but intentionally not surfaced in Discord (to avoid noise); they
  are visible at `debug` log level only if you extend the broker to log
  them.
- Attachment content type/extension allowlists are conservative and may
  need extending for your workflows (see `TEXT_EXTENSIONS` in
  `src/discord/attachments.js`).
- Gateway sharding is not implemented (not needed for a single guild).
- `session/close` is only called when the agent's capabilities advertise
  support for it; otherwise the child process is simply terminated.
