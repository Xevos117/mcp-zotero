// Fake Zotero Web API for the PoC: three items in /users/000000, no network.
const PREFIX = "/users/000000";
const ITEMS = {
  AAAA1111: { itemType: "journalArticle", title: "Alpha paper on testing", date: "2020", publicationTitle: "Journal of Tests", volume: "12", issue: "3", pages: "100-120", creators: [{ creatorType: "author", lastName: "Rossi", firstName: "Mario" }] },
  BBBB2222: { itemType: "book", title: "Beta book of fields", date: "2018", publisher: "Field Press", place: "Milano", creators: [{ creatorType: "author", lastName: "Bianchi", firstName: "Anna" }, { creatorType: "author", lastName: "Verdi", firstName: "Luca" }] },
  CCCC3333: { itemType: "bookSection", title: "Gamma chapter", bookTitle: "Collected Gammas", date: "2021", pages: "5-30", publisher: "G Press", creators: [{ creatorType: "author", lastName: "Neri", firstName: "Paola" }, { creatorType: "editor", lastName: "Gialli", firstName: "Ugo" }] },
};
globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === "string" ? input : input.url);
  const m = url.pathname.match(/^(.*)\/items\/([A-Z0-9]+)$/);
  if (url.hostname === "api.zotero.org" && (init?.method ?? "GET") === "GET" && m && m[1] === PREFIX && ITEMS[m[2]]) {
    const body = { key: m[2], version: 1, data: { key: m[2], ...ITEMS[m[2]] } };
    return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json", "Total-Results": "1", "Last-Modified-Version": "1" } });
  }
  throw new Error(`stub: unexpected network call ${url}`);
};
