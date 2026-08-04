# discord-copilot-broker

A dependency-free Node.js broker that bridges a Discord bot to the
[Copilot CLI](https://github.com/github/copilot-cli) over its Agent Client
Protocol (ACP) stdio interface. One Discord thread maps to exactly one
Copilot ACP session/process.

Zero third-party npm runtime or dev dependencies: only Node.js built-ins
(`node:*`) plus the global `WebSocket` and `fetch` APIs available in modern
Node. Plain ESM JavaScript, no TypeScript/transpilation.

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

- **This broker runs as the Linux user `sachin`, with the same filesystem
  and process privileges as any other program that user runs.** It does
  **not** provide sandboxing, containerization, or privilege separation.
  Every Copilot ACP session it spawns can read/write anything `sachin` can.
  Multiple threads' sessions **share the same host filesystem** even though
  each has an independent Copilot session id and child process — a change
  made from one thread's session is visible to every other thread's session
  and to the host.
- **The only enforced identity boundary is Discord-side authorization**:
  the configured Discord guild, channel, user, and role IDs. Anyone who
  controls that Discord account, or who compromises the bot token, has the
  same level of access to this host as the broker process does.
- **The broker does not configure or grant sudo/NOPASSWD access.** If the
  operating system account this runs as has unrestricted sudo (which is a
  separate, orthogonal, and dangerous configuration choice made outside
  this project), the broker would simply relay whatever commands Copilot
  runs under that account — it does not add or remove any such privilege,
  and the project explicitly does not configure sudoers.
- **Secrets are never logged or persisted.** The Discord bot token, Discord
  interaction tokens, GitHub/Copilot auth data, prompt/message content, and
  attachment bytes are excluded from the structured logger and from the
  on-disk state file by construction — see `src/logger.js` (key/value
  redaction) and `src/state/store.js` (explicit allow-listed fields only).
- **ACP permission requests are a UX surface, not a security control.** The
  bridge for `session/request_permission` (see below) makes the agent's own
  tool-call approval flow visible in Discord; it does not itself sandbox or
  restrict what the agent can request.

## Environment variables

| Variable | Required | Default | Notes |
|---|---|---|---|
| `DISCORD_BOT_TOKEN` | conditionally | — | Required unless `DISCORD_BOT_TOKEN_FILE` is set. Never logged. |
| `DISCORD_BOT_TOKEN_FILE` | conditionally | — | Absolute path to a protected token file or systemd credential. |
| `DISCORD_GUILD_ID` | yes | — | Decimal snowflake, 17-20 digits. |
| `DISCORD_CHANNEL_ID` | yes | — | Top-level trigger channel. Decimal snowflake. |
| `DISCORD_USER_ID` | yes | — | The only user the broker will respond to. Decimal snowflake. |
| `DISCORD_ROLE_ID` | yes | — | Role mention that also triggers a new session. Decimal snowflake. |
| `BROKER_STATE_DIR` | no | `/home/sachin/.local/state/discord-copilot-broker` | Must be absolute. Created with mode `0700`. |
| `BROKER_DEFAULT_CWD` | no | `/home/sachin` | Must be absolute. Default cwd for new Copilot sessions. |
| `COPILOT_BIN` | no | `/home/sachin/.nvm/versions/node/v24.18.1/bin/copilot` | Must be absolute. |
| `BROKER_COPILOT_ALLOW_ALL` | no | `false` | When `true`, broker sessions start Copilot with `--allow-all`, disabling tool/path/URL prompts. |
| `BROKER_MAX_SESSIONS` | no | `3` | Positive integer; caps concurrent Copilot processes. |
| `BROKER_ATTACHMENT_MAX_BYTES` | no | `10485760` (10 MiB) | Total budget shared across all attachments in one message. |
| `BROKER_ATTACHMENT_MAX_COUNT` | no | `5` | Max attachments per message. |
| `BROKER_LOG_LEVEL` | no | `info` | One of `debug`, `info`, `warn`, `error`. |

See `.env.example` for a template. Copy it to `.env`, fill in real values,
and `chmod 600 .env` (the file is git-ignored). This project does not load
`.env` files itself (no dependency for that) — export the variables in your
shell/systemd unit, or `set -a; source .env; set +a` before running.

## Local run

```sh
npm install   # no-op: zero dependencies, but validates package.json
export DISCORD_BOT_TOKEN=...        # and the other required vars
node src/index.js
```

The process logs structured JSON to stdout and exits non-zero with a clear
message if configuration is invalid or the state file is corrupt (state
corruption is never silently discarded — see below).

## systemd user service

The managed unit `discord-copilot-broker.service` runs directly as `sachin`
and uses systemd `LoadCredential` for the Discord token. Its source of truth
is the chezmoi dotfiles repository. The credential file is intentionally not
managed by chezmoi:

```text
~/.config/discord-copilot-broker/discord-bot-token
```

The service remains disabled until the live Discord cutover. User lingering
must be enabled for it to continue running after all login sessions end.

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
- **All sessions run as the same OS user against the same filesystem.**
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

**Unrestricted sudo/NOPASSWD is not configured by this application.** If
the underlying `sachin` account happens to have such access configured
elsewhere on the host, that is an operator/host-level decision entirely
outside this project's scope — the broker only ever surfaces exactly the
permission request the ACP agent itself sends, it does not grant, imply,
or manage any sudo configuration.

The installed systemd service sets `BROKER_COPILOT_ALLOW_ALL=true`, so
broker-launched Copilot processes bypass this approval workflow entirely.
This setting does not affect terminal Copilot sessions and does not grant
operating-system sudo access.

## Known limitations

- No sandboxing of Copilot child processes: see "shared-filesystem
  warning" above.
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
