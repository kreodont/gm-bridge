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
