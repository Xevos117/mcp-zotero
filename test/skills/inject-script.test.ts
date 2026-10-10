import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFile } from "node:child_process";
import { copyFile, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { makeDocx, para, zcite, readDocumentXml, tempDir, TempDir } from "../helpers/fixtures.js";

/**
 * Script standalone della skill (skills/zotero-skill-mcp-integrations/scripts/inject.js),
 * eseguito come lo esegue Claude seguendo SKILL.md: processo node separato, metadata.json
 * nel formato di get_items_details. Ogni processo ha un timeout.
 */

const ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const SCRIPT = join(ROOT, "skills", "zotero-skill-mcp-integrations", "scripts", "inject.js");
const TIMEOUT_MS = 20_000;

interface Run { code: number; stdout: string; stderr: string }

function run(args: string[], cwd = ROOT, script = SCRIPT): Promise<Run> {
  return new Promise((done) => {
    execFile(process.execPath, [script, ...args], { cwd, timeout: TIMEOUT_MS, killSignal: "SIGKILL" }, (err, stdout, stderr) => {
      const code = err ? (typeof err.code === "number" ? err.code : -1) : 0;
      done({ code, stdout, stderr });
    });
  });
}

function citations(xml: string): Array<Record<string, any>> {
  return [...xml.matchAll(/ADDIN ZOTERO_ITEM CSL_CITATION (.*?) <\/w:instrText>/g)].map((m) =>
    JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&"))
  );
}

// Formato restituito da get_items_details (DOI maiuscolo, authors come stringa)
const METADATA = {
  SMITH001: { itemType: "journalArticle", title: "On Testing", authors: "John Smith", date: "2023", DOI: "10.1/x", publicationTitle: "J. Tests", volume: "4", pages: "1-9" },
  DOEROE01: { itemType: "book", title: "Pair Book", authors: "Jane Doe, Rick Roe", date: "2019-03-01", publisher: "Press" },
};

describe("skill inject.js (processo reale)", () => {
  let dir: TempDir;
  let input: string;
  let numbered: string;
  let meta: string;

  beforeAll(async () => {
    dir = await tempDir();
    input = await dir.file(
      "paper.docx",
      await makeDocx(para("A ", zcite({ keys: "SMITH001" })) + para("B ", zcite({ keys: "SMITH001,DOEROE01", locator: "p. 3" })))
    );
    numbered = await dir.file(
      "numbered.docx",
      await makeDocx(para("A ", zcite({ keys: "SMITH001", num: "1" })) + para("B ", zcite({ keys: "SMITH001,DOEROE01", num: "1,2" })))
    );
    meta = await dir.file("metadata.json", JSON.stringify(METADATA));
  });
  afterAll(async () => {
    await dir?.cleanup();
  });

  it.each([
    ["users/<id>", "users/424242", "users/424242"],
    ["id numerico", "424242", "users/424242"],
    ["groups/<id>", "groups/777", "groups/777"],
  ])("SK-01 forma libreria %s → URI http://zotero.org/%s/items/KEY", async (_label, arg, path) => {
    const out = join(dir.path, `out-${arg.replace("/", "-")}.docx`);
    const r = await run([input, out, meta, arg]);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ output: out, found: 2, injected: 2 });
    const xml = await readDocumentXml(await readFile(out));
    const cites = citations(xml);
    expect(cites[1].citationItems.map((c: { uris: string[] }) => c.uris[0])).toEqual([
      `http://zotero.org/${path}/items/SMITH001`,
      `http://zotero.org/${path}/items/DOEROE01`,
    ]);
    expect(cites[0].citationItems[0].itemData).toMatchObject({ DOI: "10.1/x", "container-title": "J. Tests", volume: "4", page: "1-9" });
    expect(cites[0].properties.formattedCitation).toBe("(Smith, 2023)");
    expect(xml).toContain("ZOTERO_BIBL");
  });

  it("SK-02 ieee con num → [1], [1,2], nessun warning", async () => {
    const out = join(dir.path, "ieee.docx");
    const r = await run([numbered, out, meta, "424242", "ieee"]);
    expect(r.code).toBe(0);
    expect(r.stderr).not.toContain("WARNING");
    const cites = citations(await readDocumentXml(await readFile(out)));
    expect(cites.map((c) => c.properties.formattedCitation)).toEqual(["[1]", "[1,2]"]);
  });

  it("SK-03 vancouver senza num → WARNING su stderr e [?]", async () => {
    const out = join(dir.path, "vanc.docx");
    const r = await run([input, out, meta, "424242", "vancouver"]);
    expect(r.code).toBe(0);
    expect(r.stderr).toMatch(/WARNING: Style 'vancouver' requires 'num'/);
  });

  it('SK-04 keys="A, B" con spazi → chiavi ripulite, itemData presente', async () => {
    const spaced = await dir.file("spaced.docx", await makeDocx(para(zcite({ keys: "SMITH001, DOEROE01" }))));
    const out = join(dir.path, "spaced-out.docx");
    expect((await run([spaced, out, meta, "424242"])).code).toBe(0);
    const [c] = citations(await readDocumentXml(await readFile(out)));
    expect(c.citationItems.map((ci: { uris: string[] }) => ci.uris[0])).toEqual([
      "http://zotero.org/users/424242/items/SMITH001",
      "http://zotero.org/users/424242/items/DOEROE01",
    ]);
    expect(c.citationItems[1].itemData.title).toBe("Pair Book");
  });

  it("SK-05 chiave assente da metadata.json → WARNING che la nomina, exit 0", async () => {
    const missing = await dir.file("missing.docx", await makeDocx(para(zcite({ keys: "GHOST001" }))));
    const r = await run([missing, join(dir.path, "missing-out.docx"), meta, "424242"]);
    expect(r.code).toBe(0);
    expect(r.stderr).toMatch(/WARNING: 1 cited key\(s\) not found in metadata\.json: GHOST001/);
  });

  it.each([
    ["meno di 4 argomenti", (i: string, m: string) => [i, "o.docx", m], /Usage/],
    ['libreria "abc"', (i: string, m: string) => [i, "o.docx", m, "abc"], /Invalid library/],
    ['libreria "users/"', (i: string, m: string) => [i, "o.docx", m, "users/"], /Invalid library/],
    ['libreria "orgs/1"', (i: string, m: string) => [i, "o.docx", m, "orgs/1"], /Invalid library/],
    ['libreria "groups/x"', (i: string, m: string) => [i, "o.docx", m, "groups/x"], /Invalid library/],
    ['stile "mla"', (i: string, m: string) => [i, "o.docx", m, "424242", "mla"], /Invalid style 'mla'/],
    ["input inesistente", (_i: string, m: string) => ["nope.docx", "o.docx", m, "424242"], /ENOENT/],
    ["metadata inesistente", (i: string) => [i, "o.docx", "nope.json", "424242"], /ENOENT/],
  ])("SK-06 argomenti non validi: %s → exit 1", async (_label, argv, message) => {
    const r = await run(argv(input, meta));
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(message);
  });

  it('SK-07 copiato come inject.mjs in una cartella con package.json "type": "commonjs" funziona', async () => {
    const cjs = join(dir.path, "cjs");
    await mkdir(cjs);
    await writeFile(join(cjs, "package.json"), JSON.stringify({ name: "x", version: "1.0.0", type: "commonjs" }));
    await symlink(join(ROOT, "node_modules"), join(cjs, "node_modules"), "dir");
    await copyFile(SCRIPT, join(cjs, "inject.mjs"));
    const r = await run([input, join(cjs, "out.docx"), meta, "424242"], cjs, join(cjs, "inject.mjs"));
    expect(r.stderr).not.toMatch(/SyntaxError|MODULE_TYPELESS/);
    expect(r.code).toBe(0);
  });
});
