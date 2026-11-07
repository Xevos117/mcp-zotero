import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { makeOdt, odtPara, zcite, readContentXml, tempDir, TempDir } from "../helpers/fixtures.js";
import { startHarness } from "../helpers/mcp-harness.js";
import { ZBASE, zLibraryQuery, zSingle, article } from "../helpers/zotero-fake.js";
import { expectValidOdt } from "../helpers/citation-validate.js";
import { CitationStyle } from "../helpers/docx-validate.js";

/**
 * Lo script generato della skill inietta in .odt (reference mark LibreOffice) come inject_citations: stessi
 * itemData, testo e URI, nei 5 stili e in una libreria di gruppo. Il formato si deduce dall'estensione .odt.
 */

const ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const SCRIPT = join(ROOT, "skills", "zotero-skill-mcp-integrations", "scripts", "inject.js");

function run(args: string[]): Promise<{ code: number; stderr: string }> {
  return new Promise((done) => {
    execFile(process.execPath, [SCRIPT, ...args], { cwd: ROOT, timeout: 20_000, killSignal: "SIGKILL" }, (err, _o, stderr) =>
      done({ code: err ? (typeof err.code === "number" ? err.code : -1) : 0, stderr })
    );
  });
}

const ITEMS = [
  article("KRPPNQQR", { title: "Insects", date: "2017-10-18", creators: [{ creatorType: "author", firstName: "Caspar A.", lastName: "Hallmann" }, { creatorType: "author", firstName: "Hans", lastName: "de Kroon" }] }),
  { key: "CPNSPRTR", itemType: "report", title: "Consortium report", date: "2021", creators: [{ creatorType: "author", name: "Test Consortium" }] },
];
const BODY = (numbered: boolean) =>
  odtPara("A ", zcite({ keys: "KRPPNQQR", ...(numbered && { num: "1" }) })) +
  odtPara("B ", zcite({ keys: "CPNSPRTR", locator: "p. 3", prefix: "see ", ...(numbered && { num: "2" }) }));

describe("skill inject.js su odt (SK-ODT)", () => {
  let dir: TempDir;
  beforeAll(async () => {
    dir = await tempDir();
  });
  afterAll(async () => {
    await dir?.cleanup();
  });

  const cites = (xml: string) =>
    [...xml.matchAll(/<text:reference-mark-start text:name="ZOTERO_ITEM CSL_CITATION ([\s\S]*?) RND[0-9A-Za-z]{10}"\/>/g)].map((m) =>
      JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&apos;/g, "'"))
    );

  it.each<CitationStyle>(["apa", "harvard", "chicago", "ieee", "vancouver"])(
    "SK-ODT-01 stile %s: stessi itemData/testo/URI di inject_citations, odt valido",
    async (style) => {
      const numbered = style === "ieee" || style === "vancouver";
      const h = await startHarness();
      try {
        h.net.on("GET", `${ZBASE}/items`, zLibraryQuery(ITEMS));
        for (const it of ITEMS) h.net.on("GET", `${ZBASE}/items/${it.key}`, zSingle(it));
        const details = await h.call("get_items_details", { item_keys: ITEMS.map((i) => i.key) });
        const metaPath = await dir.file(`meta-${style}.json`, JSON.stringify(details.json));
        const forTool = await dir.file(`tool-${style}.odt`, await makeOdt(BODY(numbered)));
        const forScript = await dir.file(`script-${style}.odt`, await makeOdt(BODY(numbered)));
        const tool = await h.call("inject_citations", { file_path: forTool, style });
        expect(tool.isError, tool.text).toBe(false);
        const out = join(dir.path, `script-${style}-out.odt`);
        const r = await run([forScript, out, metaPath, "424242", style]);
        expect(r.code, r.stderr).toBe(0);
        const strip = (xml: string) =>
          cites(xml).map((c) => ({ text: c.properties.formattedCitation, items: c.citationItems.map((ci: any) => ({ uris: ci.uris, itemData: ci.itemData })) }));
        expect(strip(await readContentXml(await readFile(out)))).toEqual(strip(await readContentXml(await readFile(tool.json.output_path))));
        await expectValidOdt(await readFile(out), { style, libraryPath: "users/424242" });
      } finally {
        await h.close();
      }
    }
  );

  it("SK-ODT-02 libreria di gruppo → URI di gruppo validi", async () => {
    const h = await startHarness();
    try {
      h.net.on("GET", `${ZBASE}/items`, zLibraryQuery(ITEMS));
      for (const it of ITEMS) h.net.on("GET", `${ZBASE}/items/${it.key}`, zSingle(it));
      const details = await h.call("get_items_details", { item_keys: ITEMS.map((i) => i.key) });
      const metaPath = await dir.file("meta-group.json", JSON.stringify(details.json));
      const forScript = await dir.file("script-group.odt", await makeOdt(BODY(false)));
      const out = join(dir.path, "script-group-out.odt");
      const r = await run([forScript, out, metaPath, "groups/777"]);
      expect(r.code, r.stderr).toBe(0);
      await expectValidOdt(await readFile(out), { libraryPath: "groups/777" });
    } finally {
      await h.close();
    }
  });
});
