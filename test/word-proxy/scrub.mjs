// Replaces the test account's key, user id, username and group id in run outputs (artifacts are
// public): text files in place, .docx parts rewritten. Missing files are skipped.
// Usage: node scrub.mjs [--ids] file...
//   --ids: user id -> 000000 and group id -> 777 (used right after injection, so that nothing Zotero or
//          WordCraft write afterwards, including clipped trace lines, can carry the real ids; Zotero
//          resolves http://zotero.org/users/<any id>/items/KEY to the local user library anyway)
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import JSZip from "jszip";

const args = process.argv.slice(2);
const ids = args[0] === "--ids";
const files = ids ? args.slice(1) : args;
const env = process.env;
const secrets = (ids
  ? [[env.ZOTERO_TEST_USER_ID, "000000"], [env.ZOTERO_TEST_GROUP_ID, "777"]]
  : [[env.ZOTERO_TEST_API_KEY, "<api-key>"], [env.ZOTERO_TEST_USERNAME, "<username>"], [env.ZOTERO_TEST_USER_ID, "<user-id>"], [env.ZOTERO_TEST_GROUP_ID, "<group-id>"]]
).filter(([v]) => v && v.length >= 3);
const scrub = (s) => secrets.reduce((acc, [v, r]) => acc.split(v).join(r), s);

for (const file of files) {
  if (!existsSync(file)) continue;
  if (file.endsWith(".docx")) {
    const zip = await JSZip.loadAsync(await readFile(file));
    for (const name of Object.keys(zip.files)) {
      if (!zip.files[name].dir && /\.(xml|rels)$/.test(name)) zip.file(name, scrub(await zip.file(name).async("string")));
    }
    await writeFile(file, await zip.generateAsync({ type: "nodebuffer" }));
  } else {
    await writeFile(file, scrub(await readFile(file, "utf8")));
  }
}
