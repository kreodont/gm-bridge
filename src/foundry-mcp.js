#!/usr/bin/env node
/**
 * foundry-mcp — a thin MCP server over the Foundry REST relay (execute-js).
 * Gives a codex agent tools to ACTUALLY change the Foundry world: create NPCs,
 * journals, scenes, etc. It connects to codex as an external MCP server; used only
 * in "action" mode (the /do trigger), not for ordinary replies.
 *
 * stdout is owned by the MCP protocol — logs go to stderr only.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { relayExec, findActorScript, addToSceneScript } from "./world.js";

const log = (m) => process.stderr.write(`[foundry-mcp] ${m}\n`);

const mcp = new Server(
  { name: "foundry-mcp", version: "0.1.0" },
  {
    capabilities: { tools: {} },
    instructions: [
      "Tools to change the Foundry VTT (D&D 5e) world as the GM via the REST relay.",
      "When asked to add/spawn a monster or creature, ALWAYS call foundry_find_actor first",
      "and reuse an existing world/compendium actor via foundry_add_to_scene. Create a new",
      "actor from scratch only when the search finds nothing suitable.",
      "foundry_execute_js — run arbitrary JS in the world: game.actors, game.scenes,",
      "game.journal, Actor.create, Scene.create, JournalEntry.create, etc. Returns result.",
      "To create an NPC use Actor.create({name, type:'npc', system:{...}}).",
      "Forbidden: globalThis, delete, eval (the relay filter blocks them) — write without them.",
    ].join("\n"),
  }
);

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "foundry_execute_js",
      description:
        "Run JS in the Foundry world as the GM (game.*, Actor.create, Scene.create, JournalEntry.create available). Function body — use return for the result. No globalThis/delete/eval.",
      inputSchema: {
        type: "object",
        properties: {
          script: { type: "string", description: "Script body; return the result via return" },
        },
        required: ["script"],
      },
    },
    {
      name: "foundry_create_npc",
      description: "Create an NPC actor in the Foundry world. Returns the created actor's id and name.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "NPC name" },
          biography: { type: "string", description: "Bio/dossier (HTML or text), optional" },
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
          content: { type: "string", description: "HTML page content" },
        },
        required: ["name", "content"],
      },
    },
    {
      name: "foundry_find_actor",
      description:
        "Search the bestiary: actors by name in the world and in Actor compendia. Call this FIRST when asked to add a monster/creature — reuse a match instead of creating a duplicate.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Name or part of the name (case-insensitive)" },
        },
        required: ["query"],
      },
    },
    {
      name: "foundry_add_to_scene",
      description:
        "Place an existing actor on the current scene as token(s). Pass id (world actor) or id+pack (compendium entry, gets imported) from foundry_find_actor, or just a name. Defaults to the scene center.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Actor name (used when id is not given)" },
          id: { type: "string", description: "Actor id from foundry_find_actor" },
          pack: { type: "string", description: "Compendium pack id (when the actor is a compendium entry)" },
          count: { type: "number", description: "How many tokens (default 1, max 20)" },
          x: { type: "number", description: "X in pixels (default: scene center)" },
          y: { type: "number", description: "Y in pixels (default: scene center)" },
        },
      },
    },
  ],
}));

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: a = {} } = req.params;
  try {
    let result;
    if (name === "foundry_execute_js") {
      result = await relayExec(String(a.script || ""));
    } else if (name === "foundry_create_npc") {
      const script =
        `const a = await Actor.create({ name: ${JSON.stringify(a.name || "NPC")}, type: "npc" });` +
        (a.biography
          ? ` await a.update({ "system.details.biography.value": ${JSON.stringify(a.biography)} });`
          : "") +
        ` return { id: a.id, name: a.name };`;
      result = await relayExec(script);
    } else if (name === "foundry_create_journal") {
      const script =
        `const j = await JournalEntry.create({ name: ${JSON.stringify(a.name || "Entry")} });` +
        ` await j.createEmbeddedDocuments("JournalEntryPage", [{ name: ${JSON.stringify(a.name || "Page")}, text: { content: ${JSON.stringify(a.content || "")}, format: 1 } }]);` +
        ` return { id: j.id, name: j.name };`;
      result = await relayExec(script);
    } else if (name === "foundry_find_actor") {
      result = await relayExec(findActorScript(a.query));
    } else if (name === "foundry_add_to_scene") {
      result = await relayExec(addToSceneScript(a), 30000);
    } else {
      return { content: [{ type: "text", text: `unknown tool: ${name}` }], isError: true };
    }
    log(`${name} -> ok`);
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`${name} failed: ${msg}`);
    return { content: [{ type: "text", text: `error: ${msg}` }], isError: true };
  }
});

await mcp.connect(new StdioServerTransport());
log("foundry-mcp connected (stdio)");
