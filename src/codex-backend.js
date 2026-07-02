// "codex-mcp" backend: the bridge spawns `codex mcp-server` (stdio) as a child
// process and calls it as the LLM. The evening's warm context is kept via threadId
// (codex-reply continues the conversation). Long-term memory lives in the bridge's
// RAG store (memory.js), not here — so the backend stays swappable (codex / claude /
// api) without losing NPC memory.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// Isolated CODEX_HOME: only the foundry MCP server, none of the unrelated servers
// from the global ~/.codex/config.toml. Otherwise codex spins them up on every run
// and hangs on their init (observed ~4 min vs ~9s with an isolated home).
const CODEX_HOME =
  process.env.GM_CODEX_HOME ||
  join(dirname(fileURLToPath(import.meta.url)), "..", "codex-home");
const codexEnv = { ...process.env, CODEX_HOME };

// Short campaign descriptor used in the action-agent prompt. Set GM_CAMPAIGN to
// tailor it (and you can append a language instruction, e.g. "...; reply in Russian").
const CAMPAIGN = process.env.GM_CAMPAIGN || "a tabletop RPG campaign (D&D 5e)";

// Hard cap on a single codex call. Without it a stuck codex keeps the GM's
// "Assistant thinking" spinner up forever; with it the bridge returns a 504
// and the GM can retry. Generous by default — codex with tools can be slow.
const CODEX_TIMEOUT = Number(process.env.GM_CODEX_TIMEOUT_MS || 300000);

let client = null;
let connecting = null;

export async function initCodex(log) {
  if (client) return client;
  if (!connecting) {
    connecting = (async () => {
      const transport = new StdioClientTransport({ command: "codex", args: ["mcp-server"], env: codexEnv });
      const c = new Client({ name: "gm-bridge", version: "0.1.0" }, { capabilities: {} });
      await c.connect(transport);
      client = c;
      log && log("codex mcp-server connected (backend=codex-mcp)");
      return c;
    })();
  }
  return connecting;
}

// One request to codex. If threadId is set we continue the warm conversation
// (evening memory); otherwise we start a new thread with base-instructions =
// the system prompt (the world primer).
export async function askCodex({ prompt, systemPrompt, threadId }) {
  const c = await initCodex();
  let res;
  const opts = { timeout: CODEX_TIMEOUT };
  if (threadId) {
    res = await c.callTool({ name: "codex-reply", arguments: { threadId, prompt } }, undefined, opts);
  } else {
    res = await c.callTool({
      name: "codex",
      arguments: {
        prompt,
        "base-instructions": systemPrompt,
        sandbox: "read-only",
        "approval-policy": "never",
        config: { model_reasoning_effort: "low" },
      },
    }, undefined, opts);
  }
  const sc = res.structuredContent || {};
  let content = sc.content;
  let tid = sc.threadId || threadId || null;
  if (!content && Array.isArray(res.content)) {
    const t = res.content.find((x) => x.type === "text");
    content = t ? t.text : "";
  }
  return { content: (content || "").trim(), threadId: tid };
}

// ACTION mode (the /do trigger): a codex agent with foundry_* tools actually
// mutates the Foundry world. We run `codex exec` headless (the nested mcp-server
// tool hung on actions; exec is more reliable). The bypass flag is needed because
// in non-interactive mode the MCP tool would otherwise auto-cancel — the bridge's
// environment is locally trusted.
export function codexAction(request, { scene = "", npc = "" } = {}) {
  const sys =
    `You are a game-master's agent assistant for ${CAMPAIGN}. ` +
    "You have foundry_* tools to change the Foundry VTT world. " +
    "Perform the requested action by calling the right tool, then briefly confirm the result (what you did, id). " +
    "Do nothing beyond what was requested.";
  const ctx = [scene && `Scene: ${scene}`, npc && `NPC: ${npc}`].filter(Boolean).join(". ");
  const prompt = `${sys}\n${ctx ? ctx + "\n" : ""}Task: ${request}`;
  return new Promise((resolve, reject) => {
    const args = [
      "exec", "--skip-git-repo-check",
      "--dangerously-bypass-approvals-and-sandbox",
      "-c", 'model_reasoning_effort="low"',
      prompt,
    ];
    // stdin closed ('ignore'): otherwise codex exec, seeing an open pipe with no EOF,
    // blocks reading stdin and hangs (through the bridge — forever).
    const p = spawn("codex", args, { cwd: process.env.HOME, env: codexEnv, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    const killer = setTimeout(() => {
      p.kill("SIGKILL");
      reject(new Error(`codex exec timed out after ${CODEX_TIMEOUT}ms`));
    }, CODEX_TIMEOUT);
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("error", (e) => { clearTimeout(killer); reject(e); });
    p.on("close", () => {
      clearTimeout(killer);
      resolve(extractFinal(out) || "(action performed, but the agent reply could not be parsed)");
    });
  });
}

// The agent's final message from `codex exec` output (after the last marker, before "tokens used").
function extractFinal(out) {
  if (!out) return "";
  let s = out.split(/\n\s*tokens used/i)[0];
  const parts = s.split(/\ncodex\n/);
  const tail = parts[parts.length - 1] || s;
  return tail.trim().split("\n").filter((l) => l.trim() && !/^mcp:/i.test(l)).join("\n").trim();
}
