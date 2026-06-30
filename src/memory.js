// Long-term campaign RAG memory: local embeddings (multilingual-e5-small via
// transformers.js) + node:sqlite. NPCs remember past scenes across sessions.
// IMPORTANT: all logging goes to stderr — stdout is owned by the MCP protocol.
import { DatabaseSync } from "node:sqlite";
import { pipeline, env } from "@xenova/transformers";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

env.allowLocalModels = false; // pull the model from the hub and cache it; don't look for local .onnx

const HERE = dirname(fileURLToPath(import.meta.url));
const MODEL = "Xenova/multilingual-e5-small";
// DB path is configurable; default lives next to the package (../data).
const DB_PATH = process.env.GM_MEMORY_DB || join(HERE, "..", "data", "gm-memory.db");
// Header of the MEMORIES block injected into each request. Override per campaign /
// language via GM_RECALL_HEADER (e.g. a Russian sentence for a Russian campaign).
const RECALL_HEADER =
  process.env.GM_RECALL_HEADER ||
  "MEMORIES (past scenes of this campaign; do not contradict them):";
const RECALL_K = 4;          // max memories to mix in
const RECALL_MARGIN = 0.05;  // relative threshold: drop anything well below the best match

let _embedderPromise = null;
function embedder() {
  // Cache the PROMISE, not the result: otherwise parallel calls (warmup + the first
  // recall) start loading the model twice before the first one resolves.
  if (!_embedderPromise) {
    const t0 = Date.now();
    _embedderPromise = pipeline("feature-extraction", MODEL).then((e) => {
      console.error(`[memory] embedding model loaded in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
      return e;
    });
  }
  return _embedderPromise;
}

// e5 distinguishes query vs document via query:/passage: prefixes.
async function embed(text, kind = "passage") {
  const e = await embedder();
  const out = await e(`${kind}: ${text}`, { pooling: "mean", normalize: true });
  return Float32Array.from(out.data);
}

function blobOf(f32) {
  return Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength);
}
function f32Of(blob) {
  return new Float32Array(blob.buffer, blob.byteOffset, blob.byteLength / 4);
}
function cos(a, b) {
  // both vectors are already normalized -> cosine = dot product
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
}

let _db = null;
function db() {
  if (_db) return _db;
  mkdirSync(dirname(DB_PATH), { recursive: true });
  _db = new DatabaseSync(DB_PATH);
  _db.exec(`CREATE TABLE IF NOT EXISTS memories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    kind TEXT NOT NULL,          -- 'exchange' | 'event'
    npc TEXT,
    scene TEXT,
    text TEXT NOT NULL,
    embedding BLOB NOT NULL
  )`);
  _db.exec(`CREATE INDEX IF NOT EXISTS idx_memories_npc ON memories(npc)`);
  return _db;
}

// Store a memory. `now` is epoch ms (Date.now() from the caller).
export async function remember({ kind = "event", npc = null, scene = null, text, now }) {
  if (!text || !text.trim()) return;
  const vec = await embed(text, "passage");
  db().prepare(
    `INSERT INTO memories (ts, kind, npc, scene, text, embedding) VALUES (?, ?, ?, ?, ?, ?)`
  ).run(now ?? 0, kind, npc, scene, text.trim(), blobOf(vec));
}

// Fetch memories relevant to the current request. `npc` (if set) boosts that NPC's
// own memories. Returns [{text, npc, kind, score}], top-k.
export async function recall(query, { npc = null } = {}) {
  const rows = db().prepare(`SELECT ts, kind, npc, scene, text, embedding FROM memories`).all();
  if (!rows.length) return [];
  const q = await embed(query, "query");
  const nn = (npc || "").toLowerCase();
  const scored = rows.map((r) => {
    let s = cos(q, f32Of(r.embedding));
    if (nn && (r.npc || "").toLowerCase() === nn) s += 0.05; // boost the NPC's own memories
    return { text: r.text, npc: r.npc, kind: r.kind, score: s };
  });
  scored.sort((a, b) => b.score - a.score);
  const top = scored[0].score;
  return scored.filter((x) => x.score >= top - RECALL_MARGIN).slice(0, RECALL_K);
}

// Build the MEMORIES block to mix into the GM's request.
export function formatRecall(mems) {
  if (!mems.length) return "";
  const lines = mems.map((m) => {
    const tag = m.kind === "event" ? "event" : (m.npc ? m.npc : "scene");
    return `- (${tag}) ${m.text}`;
  });
  return RECALL_HEADER + "\n" + lines.join("\n");
}

// Warm the model at startup so the first in-game request doesn't wait on the load.
export async function warmup() {
  await embedder();
}
