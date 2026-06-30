#!/bin/bash
# Warm claude session — host of the assistant's channel bridge.
# Meant to run inside a tmux session (e.g. "gmasst"). It sits in the TUI and waits
# for GM requests over the channel (the gm-bridge MCP server), answering in NPC voice.
# Attach and enable fast mode: tmux attach -t gmasst  (inside: /fast)
#
# Config via env (all optional):
#   GM_SERVER_NAME   instance/MCP/channel name             (default: gm-bridge)
#   GM_SYSTEM_PROMPT path to the system prompt file         (default: <pkg>/system-prompt.txt)
#   GM_WORKDIR       claude working directory               (default: $HOME)
#   GM_MODEL         claude model                            (default: opus)
#   CLAUDE_BIN       path to the claude binary               (default: from PATH)
#   plus the bridge's own GM_* vars (GM_PORT, GM_BACKEND, GM_MEMORY_DB, GM_RELAY_ENV, ...)
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVER_NAME="${GM_SERVER_NAME:-gm-bridge}"
WORKDIR="${GM_WORKDIR:-$HOME}"
MODEL="${GM_MODEL:-opus}"
SYS_FILE="${GM_SYSTEM_PROMPT:-$SCRIPT_DIR/system-prompt.txt}"

cd "$WORKDIR" || exit 1

CLAUDE="${CLAUDE_BIN:-$(command -v claude)}"
[ -x "$CLAUDE" ] || { echo "claude binary not found (set CLAUDE_BIN)"; exit 1; }
# Resolve the real node binary (stable installation path, not a per-shell symlink)
# so the generated mcp.json keeps working after this shell goes away.
NODE_BIN="$(node -e 'process.stdout.write(process.execPath)' 2>/dev/null || command -v node)"
[ -x "$NODE_BIN" ] || { echo "node not found on PATH"; exit 1; }

SYS="$(cat "$SYS_FILE" 2>/dev/null)"

# Generate mcp.json so paths and the server name are always correct, wherever the
# package is installed and whatever GM_SERVER_NAME is set to. The server key MUST
# equal SERVER_NAME so the channel (server:NAME) and --allowedTools mcp__NAME__* match.
MCP_CONFIG="$SCRIPT_DIR/mcp.json"
cat > "$MCP_CONFIG" <<EOF
{
  "mcpServers": {
    "$SERVER_NAME": {
      "command": "$NODE_BIN",
      "args": ["$SCRIPT_DIR/src/index.js"]
    }
  }
}
EOF

# --strict-mcp-config: load ONLY this bridge from the file and ignore any
# project/user .mcp.json — the bridge lives solely in this session and must not
# leak into ordinary claude sessions opened in the working directory.
# --allowedTools: pre-approve the bridge tools, otherwise every reply hangs on
# an interactive permission prompt (in an unattended session that blocks).
exec env GM_SERVER_NAME="$SERVER_NAME" "$CLAUDE" \
  --dangerously-load-development-channels "server:$SERVER_NAME" \
  --mcp-config "$MCP_CONFIG" \
  --strict-mcp-config \
  --append-system-prompt "$SYS" \
  --model "$MODEL" \
  --allowedTools "mcp__${SERVER_NAME}__reply" "mcp__${SERVER_NAME}__remember_event" "mcp__${SERVER_NAME}__recall" "mcp__${SERVER_NAME}__foundry_execute_js" "mcp__${SERVER_NAME}__foundry_create_npc" "mcp__${SERVER_NAME}__foundry_create_journal"
