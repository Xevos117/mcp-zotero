// Writes the curated corpus library (test/fixtures/corpus/library.json) as the input of load-items.js: the same
// items, with the same keys, in the local user library and in a local group 777 (path A of word-proxy).
// Usage: node test/word-proxy/items.mjs <out.json>
import { readFile, writeFile } from "node:fs/promises";

const library = JSON.parse(await readFile(new URL("../fixtures/corpus/library.json", import.meta.url), "utf8"));
const items = library.items.map((item) => ({ key: item.key, data: item }));
const libraries = [
  { type: "user", id: 0, items },
  { type: "group", id: 777, name: "word-proxy group", items },
];
await writeFile(process.argv[2], JSON.stringify({ libraries }, null, 1));
