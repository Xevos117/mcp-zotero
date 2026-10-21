// Preloaded into build/server.js (node --import) by gen.mjs: replaces global fetch with a fake Zotero Web API that
// serves the curated corpus library (test/fixtures/corpus/library.json) as the placeholder libraries /users/000000
// and /groups/777. Any other request fails, so the injection never reaches the network.
import { readFileSync } from "node:fs";

const library = JSON.parse(readFileSync(new URL("../fixtures/corpus/library.json", import.meta.url), "utf8"));
const ITEMS = new Map(library.items.map((i) => [i.key, i]));
const LIBRARIES = new Set(["/users/000000", "/groups/777"]);

globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === "string" ? input : input.url);
  const method = (init?.method ?? "GET").toUpperCase();
  const m = url.pathname.match(/^(\/(?:users|groups)\/\d+)\/items\/([A-Z0-9]+)$/);
  if (url.hostname === "api.zotero.org" && method === "GET" && m && LIBRARIES.has(m[1])) {
    const item = ITEMS.get(m[2]);
    if (!item) return new Response("Item not found", { status: 404, headers: { "Content-Type": "text/plain" } });
    return new Response(JSON.stringify({ key: item.key, version: 1, data: { version: 1, ...item } }), {
      status: 200,
      headers: { "Content-Type": "application/json", "Last-Modified-Version": "1" },
    });
  }
  throw new Error(`word-proxy stub: unexpected network call ${method} ${url}`);
};
