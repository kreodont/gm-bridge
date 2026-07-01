#!/usr/bin/env node
/**
 * gm-bridge — a warm game-master assistant (Foundry VTT + Claude Code / codex).
 *
 * Runs as an MCP server inside a long-lived claude session (channel mechanism:
 * incoming requests are injected into the live session, the answer comes back via
 * the reply tool) and at the same time serves HTTP :8799 (contract POST /assist
 * {prompt,npc?,scene?}). Each request is enriched with the NPC dossier from Foundry
 * and relevant memories from local RAG storage; the NPC's reply is then saved back
 * to memory, so NPCs remember past scenes across sessions.
 *
 * IMPORTANT: stdout is owned by the MCP protocol. Any output goes to stderr (log()).
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import http from "node:http";
import { readFileSync, writeFileSync, unlinkSync, appendFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { matchDossier, fetchDossiers, relayExec } from "./world.js";
import { recall, remember, formatRecall, warmup } from "./memory.js";
import { askCodex, initCodex, codexAction } from "./codex-backend.js";

// LLM backend: 'claude-channel' (the bridge lives inside a warm claude session,
// default) or 'codex-mcp' (standalone bridge that spawns codex mcp-server itself).
// RAG memory is shared by both — switching backend keeps NPC memory.
const BACKEND = process.env.GM_BACKEND || "claude-channel";
// Default engine when a request doesn't pick one. A request may choose per-request
// via the `engine` field: "claude" (warm claude session) | "codex" (gpt-5.5).
// The claude engine only works when the bridge is a child of a claude session (it
// needs the channel); codex is available in any mode (lazy mcp-server / codex exec).
const DEFAULT_ENGINE = BACKEND === "codex-mcp" ? "codex" : "claude";
let channelConnected = false; // channel to the claude session is up (needed for engine=claude)
function resolveEngine(v) {
  const s = String(v || "").toLowerCase();
  if (s === "codex" || s === "chatgpt" || s === "gpt" || s === "openai") return "codex";
  if (s === "claude" || s === "opus") return "claude";
  return DEFAULT_ENGINE;
}
const HERE = dirname(fileURLToPath(import.meta.url));
// Instance name: MCP server/channel name, log prefix, lock/log filenames and the
// watchdog marker. Generic default; set via GM_SERVER_NAME (the same name must
// match in the launcher: server:NAME, --allowedTools mcp__NAME__*).
const SERVER_NAME = process.env.GM_SERVER_NAME || "gm-bridge";
// Session system prompt: path is configurable, default sits next to the package.
const SYSTEM_PROMPT = (() => {
  const path = process.env.GM_SYSTEM_PROMPT || join(HERE, "..", "system-prompt.txt");
  try { return readFileSync(path, "utf8"); } catch { return ""; }
})();
let codexThread = null; // warm thread for the current evening (codex short-term memory)

const PORT = Number(process.env.GM_PORT || 8799);
const REPLY_TIMEOUT = Number(process.env.GM_REPLY_TIMEOUT_MS || 120000);
// Lock file is configurable: instances on different backends/ports must not kill each other.
const LOCK_FILE = process.env.GM_LOCK_FILE || join(homedir(), ".claude", `${SERVER_NAME}.pid`);
const LOG_FILE = process.env.GM_LOG_FILE || join(homedir(), ".claude", `${SERVER_NAME}.log`);

function log(msg) {
  const line = `[${new Date().toISOString()}] ${SERVER_NAME}: ${msg}\n`;
  process.stderr.write(line);
  try { appendFileSync(LOG_FILE, line); } catch {}
}

log(`starting (pid=${process.pid}, ppid=${process.ppid})`);

// --- Single-instance lock: one owner of the port/channel. A new instance takes over. ---
// Match by the path to this index.js (env vars aren't visible in `ps`, so not by name).
const SELF_PATH = fileURLToPath(import.meta.url);
function pidIsBridge(pid) {
  try {
    const cmd = execSync(`ps -p ${pid} -o command=`, { encoding: "utf8" });
    return cmd.includes(SELF_PATH) || cmd.includes(HERE);
  } catch {
    return false;
  }
}
try {
  const oldPid = parseInt(readFileSync(LOCK_FILE, "utf8").trim(), 10);
  if (oldPid && oldPid !== process.pid && pidIsBridge(oldPid)) {
    log(`another bridge instance running (pid=${oldPid}) — taking over`);
    process.kill(oldPid, "SIGTERM");
    await new Promise((r) => setTimeout(r, 2000));
    try { process.kill(oldPid, "SIGKILL"); } catch {}
  }
} catch {}
writeFileSync(LOCK_FILE, String(process.pid));

process.on("unhandledRejection", (err) => log(`unhandled rejection: ${err}`));
process.on("uncaughtException", (err) => log(`uncaught exception: ${err}`));

// --- HTTP <-> channel correlation: a request waits until the session calls reply(req_id). ---
let seq = 0;
const pending = new Map(); // req_id -> { resolve, reject, timer, prompt, npc, scene }

// --- MCP server with the channel capability and tools. ---
const mcp = new Server(
  { name: SERVER_NAME, version: "0.1.0" },
  {
    capabilities: {
      tools: {},
      experimental: { "claude/channel": {} },
    },
    instructions: [
      "GM requests arrive as <channel> messages with meta.req_id.",
      "Compose the answer to be read aloud at the table and return it with a SINGLE reply tool call, passing the same req_id and text.",
      "Put only read-aloud content (a line/description) in text — no preamble or reasoning.",
      "A request may include a DOSSIER (play that NPC's voice) and a MEMORIES block (past scenes — do not contradict them).",
      "The remember_event tool saves a meaningful scene fact to long-term memory so the NPC recalls it later.",
      "The recall tool fetches past memories for a query when you need to check continuity.",
      "If ACTION MODE arrives, carry it out with the foundry_* tools (foundry_create_npc / foundry_create_journal / foundry_execute_js), then reply with a confirmation.",
    ].join("\n"),
  }
);

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "reply",
      description:
        "Return the finished answer to the GM's request. Pass req_id from the incoming message's meta and text to read aloud.",
      inputSchema: {
        type: "object",
        properties: {
          req_id: { type: "string", description: "req_id from the request meta" },
          text: { type: "string", description: "Text to read aloud at the table (content only)" },
        },
        required: ["req_id", "text"],
      },
    },
    {
      name: "remember_event",
      description:
        "Save a meaningful scene fact/event to the campaign's long-term memory (the NPC will recall it in future scenes).",
      inputSchema: {
        type: "object",
        properties: {
          text: { type: "string", description: "What happened / what the NPC decided or said" },
          npc: { type: "string", description: "Which NPC this concerns (if applicable)" },
          scene: { type: "string", description: "Location/scene (if applicable)" },
        },
        required: ["text"],
      },
    },
    {
      name: "recall",
      description: "Fetch relevant past campaign memories for a query.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "What to recall" },
          npc: { type: "string", description: "Narrow to a specific NPC's memory" },
        },
        required: ["query"],
      },
    },
    // --- ACTION tools for the Foundry world (for /do mode): the session actually mutates the world ---
    {
      name: "foundry_execute_js",
      description:
        "Run JS in the Foundry world as the GM (game.actors, game.scenes, Actor.create, Scene.create, JournalEntry.create). Return the result via return. No globalThis/delete/eval.",
      inputSchema: {
        type: "object",
        properties: { script: { type: "string", description: "Script body" } },
        required: ["script"],
      },
    },
    {
      name: "foundry_create_npc",
      description: "Create an NPC actor in Foundry. Returns id and name.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "NPC name" },
          biography: { type: "string", description: "Bio/dossier (HTML/text), optional" },
        },
        required: ["name"],
      },
    },
    {
      name: "foundry_create_journal",
      description: "Create a journal entry with a single text page. Returns id.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Journal name" },
          content: { type: "string", description: "HTML content" },
        },
        required: ["name", "content"],
      },
    },
  ],
}));

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params;
  try {
    if (name === "reply") {
      const p = pending.get(String(args.req_id));
      if (!p) {
        log(`reply for unknown req_id=${args.req_id} (timed out?)`);
        return { content: [{ type: "text", text: "req_id not found (the timeout may have expired)" }], isError: true };
      }
      p.resolve(String(args.text ?? ""));
      return { content: [{ type: "text", text: "delivered to the GM" }] };
    }
    if (name === "remember_event") {
      await remember({ kind: "event", npc: args.npc || null, scene: args.scene || null, text: args.text, now: Date.now() });
      log(`remember_event: ${(args.text || "").slice(0, 60)}`);
      return { content: [{ type: "text", text: "remembered" }] };
    }
    if (name === "recall") {
      const mems = await recall(args.query, { npc: args.npc || null });
      const text = mems.length ? formatRecall(mems) : "(nothing relevant in memory)";
      return { content: [{ type: "text", text }] };
    }
    if (name === "foundry_execute_js") {
      const r = await relayExec(String(args.script || ""));
      return { content: [{ type: "text", text: JSON.stringify(r) }] };
    }
    if (name === "foundry_create_npc") {
      const script =
        `const a = await Actor.create({ name: ${JSON.stringify(args.name || "NPC")}, type: "npc" });` +
        (args.biography ? ` await a.update({ "system.details.biography.value": ${JSON.stringify(args.biography)} });` : "") +
        ` return { id: a.id, name: a.name };`;
      const r = await relayExec(script);
      log(`foundry_create_npc: ${args.name}`);
      return { content: [{ type: "text", text: JSON.stringify(r) }] };
    }
    if (name === "foundry_create_journal") {
      const script =
        `const j = await JournalEntry.create({ name: ${JSON.stringify(args.name || "Entry")} });` +
        ` await j.createEmbeddedDocuments("JournalEntryPage", [{ name: ${JSON.stringify(args.name || "Page")}, text: { content: ${JSON.stringify(args.content || "")}, format: 1 } }]);` +
        ` return { id: j.id, name: j.name };`;
      const r = await relayExec(script);
      log(`foundry_create_journal: ${args.name}`);
      return { content: [{ type: "text", text: JSON.stringify(r) }] };
    }
    return { content: [{ type: "text", text: `unknown tool: ${name}` }], isError: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`tool ${name} failed: ${msg}`);
    return { content: [{ type: "text", text: `${name} failed: ${msg}` }], isError: true };
  }
});

function pushToChannel(content, meta) {
  return mcp.notification({
    method: "notifications/claude/channel",
    params: { content, meta },
  });
}

// Live GM directives overlay: an on-the-fly editable block with the HIGHEST priority
// (the system prompt must obey it over its own tone/format rules).
function directivesBlock(directives) {
  const d = String(directives || "").trim();
  if (!d) return "";
  return `LIVE GM DIRECTIVES (HIGHEST priority — override any general tone/format rules):\n${d}`;
}

// Assemble the request content for the channel: directives + scene + NPC dossier + memories + the request itself.
async function assemble(prompt, npc, scene, directives, sceneNotes) {
  const dossier = await matchDossier(npc, prompt);
  const resolvedNpc = dossier?.name || npc || null;
  const recallQuery = [scene, npc, prompt].filter(Boolean).join(" ");
  const mems = await recall(recallQuery, { npc: resolvedNpc });

  const parts = [];
  const dir = directivesBlock(directives);
  if (dir) parts.push(dir); // first — so the model sees the priority before anything else
  if (scene) parts.push(`Scene/location: ${scene}`);
  const notes = String(sceneNotes || "").trim();
  if (notes) {
    parts.push(`SCENE NOTES (GM-only description of this location — ground the answer in it, do not contradict it, never read it aloud verbatim):\n${notes.slice(0, 4000)}`);
  }
  if (dossier) {
    parts.push(`DOSSIER — NPC: ${dossier.name}\n${dossier.bio.slice(0, 2000)}\nStay strictly in this NPC's voice, per the dossier.`);
  } else if (npc) {
    parts.push(`NPC (no dossier — improvise in the world's tone): ${npc}`);
  }
  const recallBlock = formatRecall(mems);
  if (recallBlock) parts.push(recallBlock);
  parts.push(`GM request: ${prompt}`);
  return { content: parts.join("\n\n"), resolvedNpc };
}

// --- HTTP :8799 — contract compatible with the legacy assistant. ---
function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

const httpServer = http.createServer(async (req, res) => {
  cors(res);
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  if (req.method === "GET") {
    const dossiers = Object.keys(await fetchDossiers()).length;
    // engines: claude is available only when the channel to the claude session is up; codex always.
    const engines = [
      { id: "claude", label: "Claude (Opus)", available: channelConnected },
      { id: "codex", label: "ChatGPT (GPT-5.5)", available: true },
    ];
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, service: SERVER_NAME, dossiers, defaultEngine: DEFAULT_ENGINE, engines }));
    return;
  }

  if (req.method === "POST") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      let p;
      try { p = JSON.parse(body || "{}"); } catch { p = {}; }
      const prompt = (p.prompt || "").trim();
      const npc = (p.npc || "").trim();
      const scene = (p.scene || "").trim();
      const sceneNotes = (p.sceneNotes || "").trim();
      const directives = (p.directives || "").trim();
      const engine = resolveEngine(p.engine);
      if (!prompt) {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, error: "empty prompt" }));
        return;
      }
      if (engine === "claude" && !channelConnected) {
        res.writeHead(503, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, error: "Claude engine unavailable: the bridge is not inside a claude session (pick ChatGPT or start the warm session)" }));
        return;
      }
      const reqId = String(++seq);
      try {
        // ACTION mode: a request prefixed with /do actually changes the Foundry world.
        // codex-mcp -> codex agent with foundry tools; claude-channel -> the warm
        // claude session calls the bridge's foundry_* tools and confirms.
        const isAction = /^\/do\s+/i.test(prompt);
        if (isAction) {
          const request = prompt.replace(/^\/do\s+/i, "");
          const dossier = await matchDossier(npc, request);
          const resolvedNpc = dossier?.name || npc || null;
          let text;
          if (engine === "codex") {
            text = await codexAction(request, { scene, npc: resolvedNpc });
          } else {
            const content =
              "ACTION MODE — this is not a line to read aloud, but a command to change the Foundry world.\n" +
              (scene ? `Scene: ${scene}\n` : "") +
              `Task: ${request}\n` +
              "Do it via the foundry_* tools (foundry_create_npc / foundry_create_journal / foundry_execute_js), then call reply with req_id and a short confirmation (what you did, id).";
            text = await new Promise((resolve, reject) => {
              const timer = setTimeout(() => { if (pending.delete(reqId)) reject(new Error("action timeout")); }, REPLY_TIMEOUT);
              pending.set(reqId, { resolve, reject, timer });
              pushToChannel(content, { req_id: reqId, npc: resolvedNpc || "", scene })
                .catch((e) => { if (pending.delete(reqId)) { clearTimeout(timer); reject(e); } });
            }).finally(() => { const e = pending.get(reqId); if (e) { clearTimeout(e.timer); pending.delete(reqId); } });
          }
          res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ ok: true, text, npc: resolvedNpc, action: true, engine }));
          log(`action req=${reqId} engine=${engine} -> ${text.length} chars`);
          return;
        }

        const { content, resolvedNpc } = await assemble(prompt, npc, scene, directives, sceneNotes);
        let text;
        if (engine === "codex") {
          // Direct codex call; the evening's warm thread holds short-term context.
          const r = await askCodex({ prompt: content, systemPrompt: SYSTEM_PROMPT, threadId: codexThread });
          text = r.content;
          codexThread = r.threadId;
        } else {
          // claude-channel: push into the warm claude session, wait for reply by req_id.
          text = await new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
              if (pending.delete(reqId)) reject(new Error("timeout waiting for the session"));
            }, REPLY_TIMEOUT);
            pending.set(reqId, { resolve, reject, timer });
            pushToChannel(content, { req_id: reqId, npc: resolvedNpc || "", scene })
              .catch((e) => { if (pending.delete(reqId)) { clearTimeout(timer); reject(e); } });
          }).finally(() => {
            const e = pending.get(reqId);
            if (e) { clearTimeout(e.timer); pending.delete(reqId); }
          });
        }

        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true, text, npc: resolvedNpc, engine }));
        log(`assist req=${reqId} engine=${engine} npc=${resolvedNpc || "-"} -> ${text.length} chars`);

        // Asynchronously save the exchange to long-term memory.
        remember({
          kind: "exchange",
          npc: resolvedNpc,
          scene: scene || null,
          text: `GM request: ${prompt}\nReply${resolvedNpc ? ` (${resolvedNpc})` : ""}: ${text}`,
          now: Date.now(),
        }).catch((e) => log(`remember(exchange) failed: ${e}`));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log(`assist req=${reqId} error: ${msg}`);
        res.writeHead(504, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, error: msg }));
      }
    });
    return;
  }

  res.writeHead(405); res.end();
});

httpServer.on("error", (err) => {
  log(`HTTP server: ${err}. Port ${PORT} already in use? (old instance still alive?)`);
  process.exit(1);
});

// --- Startup ---
if (BACKEND === "claude-channel") {
  log("connecting MCP transport (claude-channel)...");
  await mcp.connect(new StdioServerTransport());
  channelConnected = true;
  log("MCP transport connected");
} else {
  log(`backend=${BACKEND}: claude channel not used`);
  initCodex(log).catch((e) => log(`codex init: ${e}`));
}

httpServer.listen(PORT, "127.0.0.1", () => log(`HTTP listening on 127.0.0.1:${PORT} (backend=${BACKEND})`));

// Warm up in the background: dossiers from Foundry + the embedding model (so the first request doesn't wait).
fetchDossiers().catch(() => {});
warmup().then(() => log("embedding model warmed up")).catch((e) => log(`warmup: ${e}`));

// --- Shutdown / watchdog (pattern from slack-bridge): die together with the host session. ---
let shuttingDown = false;
let shutdownTimer = null;
const bootPpid = process.ppid;

function doShutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  log("shutting down");
  try {
    if (readFileSync(LOCK_FILE, "utf8").trim() === String(process.pid)) unlinkSync(LOCK_FILE);
  } catch {}
  try { httpServer.close(); } catch {}
  setTimeout(() => process.exit(0), 1000);
}
function shutdown(reason, grace = 0) {
  if (shuttingDown) return;
  log(`shutdown triggered (reason=${reason}, grace=${grace}ms)`);
  if (grace > 0) {
    if (shutdownTimer) return;
    shutdownTimer = setTimeout(() => {
      if (process.stdin.destroyed || process.stdin.readableEnded || process.ppid !== bootPpid) doShutdown();
      else { log("stdin recovered, cancelling shutdown"); shutdownTimer = null; }
    }, grace);
    return;
  }
  doShutdown();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGHUP", () => shutdown("SIGHUP"));
// stdin/watchdog death — only for claude-channel (there stdin = the host's MCP channel).
// In standalone codex-mcp stdin may be closed immediately, which is not a reason to exit.
if (BACKEND === "claude-channel") {
  process.stdin.on("end", () => shutdown("stdin end", 8000));
  process.stdin.on("close", () => shutdown("stdin close", 8000));
  setInterval(() => {
    if (process.ppid !== bootPpid || process.stdin.destroyed || process.stdin.readableEnded) shutdown("watchdog", 8000);
  }, 5000).unref();
}
