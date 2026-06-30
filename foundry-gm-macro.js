/*
 * GM assistant (gm-bridge) — dialog macro for Foundry VTT.
 * Sends POST localhost:8799/assist {prompt, scene, engine, directives} to the warm
 * gm-bridge, and renders the answer as a whisper to the GM.
 *
 * Enter in the request field = send. Shift+Enter = newline.
 * Name the NPC right in the request ("Gunther: hello, travelers") — the bridge
 * detects the name and pulls the dossier; there is no separate field.
 */
const GM_ASSISTANT_URL = "http://localhost:8799/assist";
const GM_ASSISTANT_PAYLOAD_KEY = "GmAssistantInitialOptions";
const GM_ASSISTANT_ENGINE_KEY = "gmAssistantEngine";
const GM_ASSISTANT_DIRECTIVES_KEY = "gmAssistantDirectives";

// Available models. id is sent to the bridge as `engine`; the bridge routes on it.
const GM_ASSISTANT_ENGINES = [
  { id: "claude", label: "Claude (Opus)" },
  { id: "codex", label: "ChatGPT (GPT-5.5)" }
];

function escapeHTML(text) {
  return String(text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function promptFromOptions(options = {}) {
  return String(options.prompt || options.text || "").trim();
}

function consumeInitialOptions() {
  const options = game[GM_ASSISTANT_PAYLOAD_KEY];
  game[GM_ASSISTANT_PAYLOAD_KEY] = undefined;
  return options && typeof options === "object" ? options : {};
}

function savedEngine() {
  try {
    const v = game.user?.getFlag("world", GM_ASSISTANT_ENGINE_KEY);
    if (GM_ASSISTANT_ENGINES.some(e => e.id === v)) return v;
  } catch (e) { /* flag unavailable — default */ }
  return GM_ASSISTANT_ENGINES[0].id;
}
function rememberEngine(id) {
  try { game.user?.setFlag("world", GM_ASSISTANT_ENGINE_KEY, id); } catch (e) { /* ignore */ }
}
function engineLabel(id) {
  const e = GM_ASSISTANT_ENGINES.find(x => x.id === id);
  return e ? e.label : id;
}

// Live GM directives — an on-the-fly editable overlay on top of the prompt core.
// Stored in a world flag, sent with every request, takes effect on the next one.
function savedDirectives() {
  try {
    const v = game.user?.getFlag("world", GM_ASSISTANT_DIRECTIVES_KEY);
    if (typeof v === "string") return v;
  } catch (e) { /* flag unavailable */ }
  return "";
}
function rememberDirectives(text) {
  try { game.user?.setFlag("world", GM_ASSISTANT_DIRECTIVES_KEY, String(text || "")); } catch (e) { /* ignore */ }
}

async function askGmAssistant(prompt, scene, engine, directives) {
  ui.notifications.info(`Assistant thinking (${engineLabel(engine)})...`);
  try {
    const res = await fetch(GM_ASSISTANT_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt, scene, engine, directives })
    });
    const data = await res.json();
    if (!data.ok) {
      ui.notifications.error(`Assistant: ${data.error}`);
      return;
    }
    const head = data.npc ? `<b>${escapeHTML(data.npc)}</b>` : "<i>Assistant</i>";
    const model = engineLabel(data.engine || engine);
    const body = escapeHTML(data.text).replace(/\n/g, "<br>");
    await ChatMessage.create({
      content: `<div style="border-left:3px solid #b33;padding-left:8px"><div style="font-size:11px;color:#888">${head} · ${escapeHTML(model)} · request: ${escapeHTML(prompt)}</div><div>${body}</div></div>`,
      whisper: [game.user.id],
      speaker: { alias: "GM assistant" }
    });
  } catch (e) {
    ui.notifications.error(`No connection to the assistant (is the service running?): ${e.message}`);
  }
}

function openGmAssistantDialog(options = {}) {
  const initialPrompt = promptFromOptions(options);
  const curEngine = savedEngine();
  const engineOpts = GM_ASSISTANT_ENGINES
    .map(e => `<option value="${e.id}"${e.id === curEngine ? " selected" : ""}>${escapeHTML(e.label)}</option>`)
    .join("");
  const curDirectives = savedDirectives();
  const content = `
  <form>
  <div class="form-group"><label>Model</label>
  <select name="engine" style="width:100%">${engineOpts}</select></div>
  <details${curDirectives ? " open" : ""} style="margin:4px 0">
    <summary style="cursor:pointer;font-size:12px;color:#aaa">Live GM directives (tone, emphasis) — override the core</summary>
    <textarea name="directives" rows="2" style="width:100%;margin-top:4px" placeholder="e.g.: keep the sci-fi in the background, no hints until I ask; ramp up the heat">${escapeHTML(curDirectives)}</textarea>
    <div style="font-size:11px;color:#888">Saved; takes effect on the next request. Empty — the core runs as-is.</div>
  </details>
  <div class="form-group"><label>Request to the assistant</label>
  <textarea name="prompt" rows="3" style="width:100%" placeholder="e.g.: Gunther: hello, travelers / describe the town square in the heat">${escapeHTML(initialPrompt)}</textarea></div>
  <div style="font-size:11px;color:#888;margin-top:4px">Enter — send · Shift+Enter — newline</div>
  </form>`;

  new Dialog({
    title: "GM assistant",
    content,
    buttons: {
      go: {
        label: "Ask",
        icon: '<i class="fas fa-comment-dots"></i>',
        callback: async html => {
          const prompt = html.find('[name=prompt]').val()?.trim();
          if (!prompt) {
            ui.notifications.warn("Empty request");
            return;
          }
          const engine = String(html.find('[name=engine]').val() || savedEngine());
          rememberEngine(engine);
          const directives = String(html.find('[name=directives]').val() || "").trim();
          rememberDirectives(directives);
          const scene = String(options.scene || canvas?.scene?.name || "");
          await askGmAssistant(prompt, scene, engine, directives);
        }
      }
    },
    default: "go",
    render: html => {
      const ta = html.find('[name=prompt]');
      ta.trigger("focus");
      ta.on("keydown", ev => {
        if (ev.key === "Enter" && !ev.shiftKey) {
          ev.preventDefault();
          let btn = html.find('button[data-button="go"]');
          if (!btn.length) btn = html.closest(".app,.application,.window-app").find('button[data-button="go"]');
          if (!btn.length) btn = html.find(".dialog-buttons button").first();
          btn.trigger("click");
        }
      });
    }
  }, { width: 480 }).render(true);
}

const gmAssistantApi = {
  open: openGmAssistantDialog
};

game.gmAssistant = gmAssistantApi;
Hooks.callAll("gmAssistantReady", gmAssistantApi);

const initialOptions = consumeInitialOptions();
if (!initialOptions.registerOnly) openGmAssistantDialog(initialOptions);
