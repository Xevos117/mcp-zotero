// Read-only: picks up to 3 regular top-level items from the test account's user library and from
// ZOTERO_TEST_GROUP_ID, and writes them as load-items.js input plus the keys for gen.mjs. Only GET
// requests; the key is sent as a header and never printed. Usage: node fetch-items.mjs <outdir>
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

const out = process.argv[2];
const { ZOTERO_TEST_API_KEY: key, ZOTERO_TEST_USER_ID: userId, ZOTERO_TEST_GROUP_ID: groupId } = process.env;
if (!key || !userId) throw new Error("ZOTERO_TEST_API_KEY / ZOTERO_TEST_USER_ID missing");
await mkdir(out, { recursive: true });

async function get(path) {
  const res = await fetch(`https://api.zotero.org${path}`, {
    headers: { "Zotero-API-Key": key, "Zotero-API-Version": "3" },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`GET ${path.split("?")[0].replace(userId, "<user>")}: HTTP ${res.status}`);
  return res.json();
}

async function pick(prefix) {
  const items = (await get(`${prefix}/items/top?limit=50&format=json`)).filter(
    (i) => !["note", "attachment", "annotation"].includes(i.data.itemType) && i.data.title
  );
  // Prefer items that outlive a live-tests run (those create and delete "mzt-" items)
  items.sort((a, b) => Number(/^mzt-/.test(a.data.title)) - Number(/^mzt-/.test(b.data.title)));
  return items.slice(0, 3).map((i) => ({ key: i.key, data: i.data }));
}

// ids as strings: scrub.mjs --ids rewrites them to 000000 / 777 in place
const libraries = [{ type: "user", id: userId, items: await pick(`/users/${userId}`) }];
if (groupId) {
  const group = await get(`/groups/${groupId}`);
  libraries.push({ type: "group", id: groupId, name: group.data?.name, items: await pick(`/groups/${groupId}`) });
}
await writeFile(join(out, "items.json"), JSON.stringify({ libraries }));
const keys = libraries.map((l) => `${l.type}=${l.items.map((i) => i.key).join(",")}`).join("\n");
await writeFile(join(out, "keys.env"), keys + "\n");
for (const l of libraries) {
  const transient = l.items.filter((i) => /^mzt-/.test(i.data.title)).length;
  console.log(`${l.type}: ${l.items.length} items (${l.items.map((i) => i.data.itemType).join(", ")}), ${transient} created by a live run`);
}
