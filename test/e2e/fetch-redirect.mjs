// Preload per il server avviato negli e2e (`node --import <questo file> build/server.js`).
// Reindirizza OGNI fetch verso host esterni (api.zotero.org, doi.org,
// api.unpaywall.org, storage S3, URL dei PDF, ...) al proxy finto locale
// indicato da FAKE_NET_PORT: nessuna richiesta può uscire verso la rete reale.
// zotero-api-client usa il fetch globale, quindi anche le sue chiamate passano di qui.

const port = process.env.FAKE_NET_PORT;
if (!port) {
  process.stderr.write("fetch-redirect: FAKE_NET_PORT non impostata\n");
  process.exit(97);
}

const realFetch = globalThis.fetch;
const LOCAL = new Set(["127.0.0.1", "localhost", "[::1]"]);

function proxied(url) {
  const u = new URL(url);
  if (LOCAL.has(u.hostname)) return null;
  return `http://127.0.0.1:${port}/__proxy/${u.protocol.replace(":", "")}/${u.host}${u.pathname}${u.search}`;
}

globalThis.fetch = function redirectedFetch(input, init) {
  if (input instanceof Request) {
    const target = proxied(input.url);
    return realFetch(target ? new Request(target, input) : input, init);
  }
  const target = proxied(String(input));
  return realFetch(target ?? input, init);
};
