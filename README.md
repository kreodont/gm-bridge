# gm-bridge — a warm game-master assistant for Foundry VTT

Instead of a cold `claude -p` per request, gm-bridge keeps **one warm session** that
pays no warm-up cost, can run fast mode, and remembers the game. Long-term memory
(RAG) survives session restarts: NPCs remember past conversations and events across
sessions. You drive it from Foundry chat; answers are whispered to the GM.

Two LLM backends, switchable per request from the UI:

- **Claude** — a warm Claude Code session hosts the bridge over the channel mechanism.
- **ChatGPT (codex)** — the bridge spawns `codex` itself (no warm session needed).

## How it works

```
Foundry chat  (dialog macro)
      │ fetch
      ▼
HTTP :8799  POST /assist {prompt, npc?, scene?, engine?, directives?}
      │
   gm-bridge
      │  1. matchDossier(npc)  — NPC biographies from Foundry (REST relay)
      │  2. recall(prompt)     — RAG memory (local embeddings + sqlite)
      │  3a. engine=claude  → push notifications/claude/channel {content, meta.req_id}
      │  3b. engine=codex   → call codex (warm thread) / `codex exec` for /do
      ▼
LLM answers in NPC voice → reply(req_id, text)
      ▼
bridge matches req_id → HTTP response → whisper to the GM in Foundry
      └─ async: remember(exchange) → memory
```

The channel mechanism uses Claude Code's `--dangerously-load-development-channels`.

## Requirements

- Node.js 22+ (uses the built-in `node:sqlite`).
- [Claude Code](https://claude.com/claude-code) on PATH (for the `claude` backend).
- `codex` CLI on PATH (only for the `codex` backend).
- A running Foundry VTT world with a REST relay that exposes `POST /execute-js`
  (used to read NPC dossiers and to perform `/do` actions).

## Install

```bash
npm install
cp .env.example .env                       # fill in FOUNDRY_RELAY_* (see below)
cp system-prompt.example.txt system-prompt.txt   # write your world/setting here
```

Set the relay credentials either as environment variables (`FOUNDRY_RELAY_URL`,
`FOUNDRY_RELAY_API_KEY`, `FOUNDRY_RELAY_CLIENT_ID`) or in a file pointed to by
`GM_RELAY_ENV` (default `./foundry-relay.env`) with the same keys.

### Run (claude backend)

The launcher hosts the warm session; run it inside a tmux session so it stays up:

```bash
tmux new -s gmasst
./start-gm-session.sh
```

On the **first start** Claude Code shows an interactive confirmation for
`--dangerously-load-development-channels` ("I am using this for local development").
Press Enter once, or the MCP bridge won't initialize and :8799 won't come up.
The bridge tools are pre-approved via `--allowedTools`, so individual replies don't
prompt. Enable fast mode any time with `/fast` inside the session.

To run the **codex backend** standalone instead (no warm claude session):

```bash
GM_BACKEND=codex-mcp npm start
```

See `codex-home/config.example.toml` for the isolated `CODEX_HOME` the codex backend
needs (only the foundry MCP server, plus an `auth.json` symlink).

### Install the Foundry macro

Create a Script macro in your world with the contents of `foundry-gm-macro.js` and
run it once while logged in as the GM. It opens a dialog where you pick the model,
optionally set live directives, and type the request. The answer is whispered to you.

Type the NPC name right in the request — `Gunther: hello, travelers` — and the bridge
pulls that actor's biography as the dossier.

## Configuration

All configuration is via environment variables (see `.env.example`). Highlights:

| Var | Default | Purpose |
|-----|---------|---------|
| `FOUNDRY_RELAY_URL` / `_API_KEY` / `_CLIENT_ID` | — | Foundry REST relay credentials |
| `GM_RELAY_ENV` | `./foundry-relay.env` | env-file fallback for the relay keys |
| `GM_SERVER_NAME` | `gm-bridge` | MCP/channel name; prefix of lock/log files |
| `GM_BACKEND` | `claude-channel` | `claude-channel` or `codex-mcp` |
| `GM_CAMPAIGN` | `a tabletop RPG campaign (D&D 5e)` | descriptor for the codex action agent |
| `GM_SYSTEM_PROMPT` | `./system-prompt.txt` | system prompt file |
| `GM_MEMORY_DB` | `./data/gm-memory.db` | RAG memory database |
| `GM_PORT` | `8799` | HTTP port |
| `GM_RECALL_HEADER` | English | header of the injected MEMORIES block |

The **live directives** field in the macro is an overlay with the highest priority:
it overrides the system prompt's tone/format rules on the fly, for both backends,
with no restart.

## Memory

- Every exchange is auto-saved (`kind=exchange`).
- The session records canon via the `remember_event` tool ("Marwen betrayed the party").
- `recall` ranks by semantic similarity (top-4, relative threshold) and boosts the
  NPC's own memories.
- Reset campaign memory: delete the file at `GM_MEMORY_DB`.

Embeddings run locally and offline via `@xenova/transformers`
(`Xenova/multilingual-e5-small`); the model is downloaded and cached on first run.

## Operations

- Bridge log: `~/.claude/<GM_SERVER_NAME>.log` (start, requests, shutdown reason).
- Single-instance lock: `~/.claude/<GM_SERVER_NAME>.pid` (a new instance takes the port).
- Health: `curl localhost:8799/` → `{ok, dossiers, engines, defaultEngine}`.
- The channel banner `server:<name> · no MCP server configured with that name` is
  cosmetic: the bridge only uses the channel message-injection protocol, not a full
  channel package. It does not affect operation.

## License

MIT.
