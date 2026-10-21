// Replaces the test account's key, user id, username and group id in run outputs before they are
// uploaded (artifacts are public): text files in place, .docx parts rewritten. Usage: node scrub.mjs file...
import { readFile, writeFile } from "node:fs/promises";
import JSZip from "jszip";

const secrets = [
  [process.env.ZOTERO_TEST_API_KEY, "<api-key>"],
  [process.env.ZOTERO_TEST_USERNAME, "<username>"],
  [process.env.ZOTERO_TEST_USER_ID, "<user-id>"],
  [process.env.ZOTERO_TEST_GROUP_ID, "<group-id>"],
].filter(([v]) => v && v.length >= 3);
const scrub = (s) => secrets.reduce((acc, [v, r]) => acc.split(v).join(r), s);

for (const file of process.argv.slice(2)) {
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
