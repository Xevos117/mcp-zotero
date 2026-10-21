// Writes the stub library (stub.mjs items) as a load-items.js input, titles marked "[library]" so the
// refreshed text shows whether Zotero used the local item or the itemData embedded in the field.
// Usage: node stub-items.mjs out.json [groupID]   (groupID: the same items also in a local group)
import { writeFile } from "node:fs/promises";
import { ITEMS } from "./stub.mjs";
const items = Object.entries(ITEMS).map(([key, data]) => ({ key, data: { ...data, title: `${data.title} [library]` } }));
const libraries = [{ type: "user", id: 0, items }];
if (process.argv[3]) libraries.push({ type: "group", id: Number(process.argv[3]), name: "word-proxy group", items });
await writeFile(process.argv[2], JSON.stringify({ libraries }, null, 1));
