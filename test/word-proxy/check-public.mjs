// Fail-closed guard for public artifacts of the library job: exits 1 if any file still contains the
// test account's key, user id, username, group id, a group name from items.json, or a numeric
// zotero.org user/group id other than the placeholders 000000 / 777. Values are compared in-process
// and never printed. Usage: node check-public.mjs <items.json|-> file...
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import JSZip from "jszip";

const [itemsFile, ...files] = process.argv.slice(2);
const literals = ["ZOTERO_TEST_API_KEY", "ZOTERO_TEST_USER_ID", "ZOTERO_TEST_USERNAME", "ZOTERO_TEST_GROUP_ID"]
  .map((n) => process.env[n])
  .filter((v) => v && v.length >= 3);
if (itemsFile !== "-" && existsSync(itemsFile)) {
  for (const lib of JSON.parse(await readFile(itemsFile, "utf8")).libraries ?? []) {
    if (lib.name && lib.name.length >= 3) literals.push(lib.name);
  }
}
let bad = 0;
for (const file of files) {
  if (!existsSync(file)) continue;
  let text;
  if (file.endsWith(".docx")) {
    const zip = await JSZip.loadAsync(await readFile(file));
    text = (await Promise.all(Object.values(zip.files).filter((f) => !f.dir).map((f) => f.async("string")))).join("\n");
  } else {
    text = await readFile(file, "utf8");
  }
  const ids = [...text.matchAll(/zotero\.org\/(users|groups)\/(\d+)/g)].filter(
    (m) => !(m[1] === "users" ? m[2] === "000000" : m[2] === "777")
  );
  if (literals.some((v) => text.includes(v)) || ids.length) {
    console.error(`check-public: account data in ${file.split("/").pop()}`);
    bad++;
  }
}
if (bad) process.exit(1);
console.log(`check-public: ${files.length} file(s) clean`);
