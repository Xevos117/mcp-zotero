import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { makeDocx, para, tempDir, TempDir } from "../helpers/fixtures.js";

/**
 * redact.mjs (agent smoke): sostituisce gli identificatori dell'account di test in agent-out/ prima di
 * caricare gli artifact su un repo pubblico. Qui si verifica docx (parti XML) e il caso robusto di un
 * file .docx che non è uno zip (un placeholder scritto dall'agente): redatto come testo, mai un crash.
 */

const ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const SCRIPT = join(ROOT, "test", "live", "agent", "redact.mjs");
const USER_ID = "7654321";
const USER_PLACEHOLDER = "100000000000001";
const ENV = { ...process.env, ZOTERO_TEST_USER_ID: USER_ID, ZOTERO_TEST_USERNAME: "", ZOTERO_TEST_GROUP_ID: "", ZOTERO_TEST_GROUP_NAME: "", ZOTERO_TEST_API_KEY: "", UNPAYWALL_EMAIL: "" };

function run(mode: string, dir: string, env = ENV): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((done) => {
    execFile(process.execPath, [SCRIPT, mode, dir], { timeout: 20_000, env }, (err, stdout, stderr) =>
      done({ code: err ? (typeof err.code === "number" ? err.code : -1) : 0, stdout, stderr })
    );
  });
}

const URI = (id: string) => `http://zotero.org/users/${id}/items/ABCD2345`;

describe("redact.mjs (RED)", () => {
  let dir: TempDir;
  beforeEach(async () => {
    dir = await tempDir();
  });
  afterEach(async () => {
    await dir.cleanup();
  });

  it("RED-01 docx: l'id utente nelle parti XML diventa il placeholder; restore lo ripristina", async () => {
    const path = await dir.file("paper.docx", await makeDocx(para(URI(USER_ID))));
    const r = await run("redact", dir.path);
    expect(r.code, r.stderr).toBe(0);
    const { readDocumentXml } = await import("../helpers/fixtures.js");
    let xml = await readDocumentXml(await readFile(path));
    expect(xml).not.toContain(USER_ID);
    expect(xml).toContain(USER_PLACEHOLDER);
    const restore = await run("restore", dir.path);
    expect(restore.code, restore.stderr).toBe(0);
    xml = await readDocumentXml(await readFile(path));
    expect(xml).toContain(USER_ID);
  });

  it("RED-02 .docx che non è uno zip: redatto come testo, nessun crash", async () => {
    const path = join(dir.path, "placeholder.docx");
    await writeFile(path, `this is not a real zip, just ${URI(USER_ID)}\n`);
    const r = await run("redact", dir.path);
    expect(r.code, r.stderr).toBe(0); // niente "Can't find end of central directory"
    const out = await readFile(path, "utf8");
    expect(out).not.toContain(USER_ID);
    expect(out).toContain(USER_PLACEHOLDER);
  });

  it("RED-03 file di testo: id nel json redatto", async () => {
    const path = await dir.file("meta.json", JSON.stringify({ uri: URI(USER_ID) }));
    const r = await run("redact", dir.path);
    expect(r.code, r.stderr).toBe(0);
    expect(await readFile(path, "utf8")).not.toContain(USER_ID);
  });
});
