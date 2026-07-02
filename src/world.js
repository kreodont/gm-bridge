// Foundry world access via the REST relay: pull NPC dossiers (actor biographies)
// and match the NPC the GM named. Relay credentials come from the environment, or
// from an env-file fallback (GM_RELAY_ENV).
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
// Env-file with FOUNDRY_RELAY_* keys; used only as a fallback when the vars are not
// already in process.env. Default sits next to the package.
const RELAY_ENV_FILE = process.env.GM_RELAY_ENV || join(HERE, "..", "foundry-relay.env");

function readEnv(key) {
  if (process.env[key]) return process.env[key];
  try {
    for (const raw of readFileSync(RELAY_ENV_FILE, "utf8").split("\n")) {
      const line = raw.trim();
      if (line.startsWith(key + "=")) return line.slice(key.length + 1).trim().replace(/^["']|["']$/g, "");
    }
  } catch {}
  return null;
}

const RELAY = (readEnv("FOUNDRY_RELAY_URL") || "http://localhost:3010").replace(/\/$/, "");
const RELAY_KEY = readEnv("FOUNDRY_RELAY_API_KEY");
const CLIENT = readEnv("FOUNDRY_RELAY_CLIENT_ID"); // world clientId, e.g. fvtt_xxxxxxxx

// Run arbitrary JS in the world as the GM. Returns `result`, or throws.
export async function relayExec(script, timeoutMs = 20000) {
  if (!RELAY_KEY) throw new Error("missing FOUNDRY_RELAY_API_KEY");
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(`${RELAY}/execute-js?clientId=${CLIENT}`, {
      method: "POST",
      headers: { "x-api-key": RELAY_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ clientId: CLIENT, script }),
      signal: ac.signal,
    });
    const data = await res.json();
    if (!data.success) throw new Error("relay: " + (data.error || "not success"));
    return data.result;
  } finally {
    clearTimeout(t);
  }
}

let _dossiers = null; // name -> biography (plain text)

// Pull NPC-actor biographies once (these hold the full dossiers with speech samples).
export async function fetchDossiers() {
  if (_dossiers) return _dossiers;
  _dossiers = {};
  if (!RELAY_KEY) return _dossiers;
  try {
    const script =
      "const out={}; for (const a of game.actors){ if(a.type!=='npc') continue; " +
      "const b=a.system?.details?.biography?.value||''; if(b.length>200) " +
      "out[a.name]=b.replace(/<[^>]+>/g,' ').replace(/\\s+/g,' ').trim(); } return out;";
    const r = await relayExec(script);
    if (r && typeof r === "object") {
      _dossiers = r;
      console.error(`[world] dossiers loaded: ${Object.keys(_dossiers).length} NPC`);
    }
  } catch (e) {
    console.error("[world] could not load dossiers (Foundry offline?):", String(e).slice(0, 120));
  }
  return _dossiers;
}

const norm = (s) => (s || "").toLowerCase().replace(/[^a-zа-яё0-9]+/g, "");

// Find a dossier by NPC name (exact/partial match) or by a mention in the request text.
export async function matchDossier(npc, prompt) {
  const d = await fetchDossiers();
  const names = Object.keys(d);
  if (!names.length) return null;
  const nn = norm(npc);
  if (nn) {
    for (const name of names) {
      const m = norm(name);
      if (m.startsWith(nn) || m.includes(nn) || nn.includes(m)) return { name, bio: d[name] };
    }
  }
  const p = (prompt || "").toLowerCase();
  for (const name of names) {
    const first = name.split(",")[0].split(/\s+/)[0];
    if (first.length > 3 && p.includes(first.toLowerCase())) return { name, bio: d[name] };
  }
  return null;
}

// --- Script builders for the bestiary tools (shared by index.js and foundry-mcp.js) ---

// Search actors by name in the world and in Actor compendia (the bestiary).
export function findActorScript(query) {
  return (
    `const q = ${JSON.stringify(String(query || ""))}.toLowerCase();` +
    ` const world = game.actors.filter(a => a.name.toLowerCase().includes(q)).slice(0, 15)` +
    `.map(a => ({ id: a.id, name: a.name, type: a.type, cr: a.system?.details?.cr ?? null }));` +
    ` const compendium = [];` +
    ` for (const pack of game.packs.filter(p => p.documentName === "Actor")) {` +
    `   const idx = await pack.getIndex();` +
    `   for (const e of idx) { if ((e.name || "").toLowerCase().includes(q)) compendium.push({ id: e._id, name: e.name, pack: pack.collection }); if (compendium.length >= 15) break; }` +
    `   if (compendium.length >= 15) break;` +
    ` }` +
    ` return { world, compendium };`
  );
}

// Place an existing actor (world or compendium) on the current scene as token(s).
export function addToSceneScript({ name = "", id = "", pack = "", count = 1, x = null, y = null } = {}) {
  const n = Math.max(1, Math.min(20, Number(count) || 1));
  return (
    `let actor = null;` +
    ` const pk = ${JSON.stringify(String(pack || ""))};` +
    ` const aid = ${JSON.stringify(String(id || ""))};` +
    ` const nm = ${JSON.stringify(String(name || ""))};` +
    ` if (pk) { const p = game.packs.get(pk); if (!p) return { error: "pack not found: " + pk }; actor = await game.actors.importFromCompendium(p, aid); }` +
    ` else if (aid) actor = game.actors.get(aid);` +
    ` if (!actor && nm) { const q = nm.toLowerCase(); actor = game.actors.find(a => a.name.toLowerCase() === q) || game.actors.find(a => a.name.toLowerCase().includes(q)); }` +
    ` if (!actor) return { error: "actor not found — use foundry_find_actor first" };` +
    ` const scene = canvas?.scene || game.scenes.active;` +
    ` if (!scene) return { error: "no active scene" };` +
    ` const d = scene.dimensions, g = scene.grid.size;` +
    ` const snap = (v) => Math.round(v / g) * g;` +
    ` const cx = ${x === null ? "snap(d.sceneX + d.sceneWidth / 2)" : JSON.stringify(Number(x))};` +
    ` const cy = ${y === null ? "snap(d.sceneY + d.sceneHeight / 2)" : JSON.stringify(Number(y))};` +
    ` const tokens = [];` +
    ` for (let i = 0; i < ${n}; i++) { const td = await actor.getTokenDocument({ x: cx + (i % 5) * g, y: cy + Math.floor(i / 5) * g }); tokens.push(td.toObject()); }` +
    ` const created = await scene.createEmbeddedDocuments("Token", tokens);` +
    ` return { actor: { id: actor.id, name: actor.name }, scene: scene.name, tokens: created.map(t => t.id) };`
  );
}
