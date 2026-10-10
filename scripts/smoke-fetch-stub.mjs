// Preloaded by smoke-stdio.mjs (node --import). Replaces global fetch so the built server
// exercises the real zotero-api-client without ever reaching the network.
// SMOKE_LIBRARY_PREFIX ("/users/<id>" or "/groups/<id>") is the only library the stub serves:
// a request for any other library fails, so the smoke proves which library the server targets.
const PREFIX = process.env.SMOKE_LIBRARY_PREFIX;

const COLLECTIONS = [
  { key: "SMOKE001", version: 1, data: { key: "SMOKE001", name: "Smoke collection", parentCollection: false } },
];
const ITEM = {
  key: "SMOKEITM",
  version: 1,
  data: { key: "SMOKEITM", itemType: "journalArticle", title: "Smoke paper", date: "2026", creators: [{ creatorType: "author", lastName: "Tester", firstName: "S" }] },
};

function json(body, total) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json", "Total-Results": String(total), "Last-Modified-Version": "1" },
  });
}

globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === "string" ? input : input.url);
  const method = (init?.method ?? "GET").toUpperCase();
  if (url.hostname === "api.zotero.org" && method === "GET") {
    if (url.pathname === `${PREFIX}/collections`) return json(COLLECTIONS, 1);
    if (url.pathname === `${PREFIX}/items/SMOKEITM`) return json(ITEM, 1);
  }
  throw new Error(`smoke: unexpected network call ${method} ${url}`);
};
