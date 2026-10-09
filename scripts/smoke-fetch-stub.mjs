// Preloaded by smoke-stdio.mjs (node --import). Replaces global fetch so the built server
// exercises the real zotero-api-client without ever reaching the network.
const COLLECTIONS = [
  { key: "SMOKE001", version: 1, data: { key: "SMOKE001", name: "Smoke collection", parentCollection: false } },
];

globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === "string" ? input : input.url);
  const method = (init?.method ?? "GET").toUpperCase();
  if (url.hostname === "api.zotero.org" && method === "GET" && url.pathname === "/users/000000/collections") {
    return new Response(JSON.stringify(COLLECTIONS), {
      status: 200,
      headers: { "Content-Type": "application/json", "Total-Results": "1", "Last-Modified-Version": "1" },
    });
  }
  throw new Error(`smoke: unexpected network call ${method} ${url}`);
};
