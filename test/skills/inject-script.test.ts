import JSZip from "jszip";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFile } from "node:child_process";
import { copyFile, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { makeDocx, para, zcite, readDocumentXml, tempDir, TempDir } from "../helpers/fixtures.js";
import { startHarness } from "../helpers/mcp-harness.js";
import { ZBASE, zLibraryQuery, zSingle, article } from "../helpers/zotero-fake.js";
import { citations, expectValidDocx, styleId, CitationStyle } from "../helpers/docx-validate.js";

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

// Formato restituito da get_items_details (DOI maiuscolo, authors come stringa)
const METADATA = {
  SMITH222: { itemType: "journalArticle", title: "On Testing", authors: "John Smith", date: "2023", DOI: "10.1/x", publicationTitle: "J. Tests", volume: "4", pages: "1-9" },
  PAIR2222: { itemType: "book", title: "Pair Book", authors: "Jane Doe, Rick Roe", date: "2019-03-01", publisher: "Press" },
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
      await makeDocx(para("A ", zcite({ keys: "SMITH222" })) + para("B ", zcite({ keys: "SMITH222,PAIR2222", locator: "p. 3" })))
    );
    numbered = await dir.file(
      "numbered.docx",
      await makeDocx(para("A ", zcite({ keys: "SMITH222", num: "1" })) + para("B ", zcite({ keys: "SMITH222,PAIR2222", num: "1,2" })))
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
      `http://zotero.org/${path}/items/SMITH222`,
      `http://zotero.org/${path}/items/PAIR2222`,
    ]);
    expect(cites[0].citationItems[0].itemData).toMatchObject({ DOI: "10.1/x", "container-title": "J. Tests", volume: "4", page: "1-9" });
    expect(cites[0].properties.formattedCitation).toBe("(Smith, 2023)");
    expect(xml).toContain("ZOTERO_BIBL");
    await expectValidDocx(await readFile(out), { libraryPath: path });
  });

  it("SK-02 ieee con num → [1], [1,2], nessun warning", async () => {
    const out = join(dir.path, "ieee.docx");
    const r = await run([numbered, out, meta, "424242", "ieee"]);
    expect(r.code).toBe(0);
    expect(r.stderr).not.toContain("WARNING");
    const cites = citations(await readDocumentXml(await readFile(out)));
    expect(cites.map((c) => c.properties.formattedCitation)).toEqual(["[1]", "[1,2]"]);
    await expectValidDocx(await readFile(out), { style: "ieee" });
  });

  it("SK-03 vancouver senza num → WARNING su stderr e [?]", async () => {
    const out = join(dir.path, "vanc.docx");
    const r = await run([input, out, meta, "424242", "vancouver"]);
    expect(r.code).toBe(0);
    expect(r.stderr).toMatch(/WARNING: Style 'vancouver' requires 'num'/);
  });

  it('SK-04 keys="A, B" con spazi → chiavi ripulite, itemData presente', async () => {
    const spaced = await dir.file("spaced.docx", await makeDocx(para(zcite({ keys: "SMITH222, PAIR2222" }))));
    const out = join(dir.path, "spaced-out.docx");
    expect((await run([spaced, out, meta, "424242"])).code).toBe(0);
    const [c] = citations(await readDocumentXml(await readFile(out)));
    expect(c.citationItems.map((ci: { uris: string[] }) => ci.uris[0])).toEqual([
      "http://zotero.org/users/424242/items/SMITH222",
      "http://zotero.org/users/424242/items/PAIR2222",
    ]);
    expect(c.citationItems[1].itemData.title).toBe("Pair Book");
  });

  it("SK-05 chiavi assenti da metadata.json → exit 1 con l'elenco (come inject_citations), nessun output", async () => {
    const missing = await dir.file("missing.docx", await makeDocx(para(zcite({ keys: "GHPSTQQR" })) + para(zcite({ keys: "SMITH222,GHPSTQQS" }))));
    const out = join(dir.path, "missing-out.docx");
    const r = await run([missing, out, meta, "424242"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("2 cited key(s) not found in the metadata: GHPSTQQR, GHPSTQQS");
    await expect(readFile(out)).rejects.toThrow();
  });

  it.each([
    ["../tags", "../tags"],
    ["AB?C", "AB?C"],
    ["SMITH222,../items/X", "../items/X"],
    ["SMITH001", "SMITH001"],
    ["SMITH222,abcd2345", "abcd2345"],
  ])(
    'SK-10 chiave <zcite> non valida per Zotero "%s" → exit 1 con lo stesso errore di inject_citations (nomina "%s"), nessun output',
    async (keys, badKey) => {
      const bad = await dir.file("badkey.docx", await makeDocx(para(zcite({ keys }))));
      const out = join(dir.path, "badkey-out.docx");
      const r = await run([bad, out, meta, "424242"]);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain(`Invalid Zotero item key(s) in <zcite>: ${badKey} (a key is 8 characters from 23456789ABCDEFGHIJKLMNPQRSTUVWXYZ)`);
      await expect(readFile(out)).rejects.toThrow();
    }
  );

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

  it("SK-08 metadata da get_items_details (con not_found) → itemData e testo identici a inject_citations (cognomi multiparola, nome istituzionale, nessun autore, capitolo con curatori, locator/prefix/suffix)", async () => {
    const items = [
      article("KRPPNQQR", { title: "Insects", date: "2017-10-18", volume: "12", creators: [
        { creatorType: "author", firstName: "Caspar A.", lastName: "Hallmann" },
        { creatorType: "author", firstName: "Hans", lastName: "de Kroon" },
      ] }),
      { key: "SILVAQQR", itemType: "book", title: "Handbook", date: "2020", publisher: "Press",
        creators: [{ creatorType: "author", firstName: "Paulo", lastName: "Caetano da Silva" }, { creatorType: "editor", firstName: "Ed", lastName: "Itor" }] },
      { key: "CPNSPRTR", itemType: "report", title: "Consortium report", date: "2021", creators: [{ creatorType: "author", name: "Test Consortium" }] },
      { key: "NPAUTHQR", itemType: "document", title: "Anonymous memo", date: "2019", creators: [] },
      { key: "CHAPTER2", itemType: "bookSection", title: "Gamma chapter", bookTitle: "Collected Gammas", pages: "5-30", date: "2020",
        creators: [{ creatorType: "author", firstName: "Gina", lastName: "Gamma" }, { creatorType: "editor", firstName: "Ugo", lastName: "Gialli" }] },
    ];
    const h = await startHarness();
    try {
      h.net.on("GET", `${ZBASE}/items`, zLibraryQuery(items));
      for (const it of items) h.net.on("GET", `${ZBASE}/items/${it.key}`, zSingle(it));
      const keys = items.map((i) => i.key);
      const details = await h.call("get_items_details", { item_keys: [...keys, "GHPSTQQR"] });
      expect(details.json.not_found).toEqual(["GHPSTQQR"]);
      const metaPath = await dir.file("meta-live.json", JSON.stringify(details.json));
      const body =
        para(zcite({ keys: "KRPPNQQR" })) +
        para(zcite({ keys: "SILVAQQR,CPNSPRTR" })) +
        para(zcite({ keys: "NPAUTHQR" })) +
        para(zcite({ keys: "CHAPTER2", locator: "7", prefix: "see", suffix: ", n. 3" }));
      const forTool = await dir.file("eq-tool.docx", await makeDocx(body));
      const forScript = await dir.file("eq-script.docx", await makeDocx(body));

      const tool = await h.call("inject_citations", { file_path: forTool });
      expect(tool.isError).toBe(false);
      const out = join(dir.path, "eq-script-out.docx");
      const r = await run([forScript, out, metaPath, "424242"]);
      expect(r.code).toBe(0);

      const strip = (cites: Array<Record<string, any>>) =>
        cites.map((c) => ({ text: c.properties.formattedCitation, items: c.citationItems.map((ci: any) => ({ uris: ci.uris, itemData: ci.itemData })) }));
      const fromTool = strip(citations(await readDocumentXml(await readFile(tool.json.output_path))));
      const fromScript = strip(citations(await readDocumentXml(await readFile(out))));
      expect(fromScript).toEqual(fromTool);
      expect(fromScript.map((c) => c.text)).toEqual([
        "(Hallmann & de Kroon, 2017)",
        "(Caetano da Silva, 2020; Test Consortium, 2021)",
        '("Anonymous memo", 2019)',
        "(see Gamma, 2020, p. 7, n. 3)",
      ]);
      expect(fromScript[3].items[0].itemData).toMatchObject({ "container-title": "Collected Gammas", editor: [{ family: "Gialli", given: "Ugo" }] });
      expect(fromScript[1].items[1].itemData.author).toEqual([{ literal: "Test Consortium" }]);
      await expectValidDocx(await readFile(out));
    } finally {
      await h.close();
    }
  });

  it("SK-P01 marcatori Pandoc [@KEY]: itemData, testo e bibliografia identici a inject_citations (ramo pandoc)", async () => {
    const items = [
      article("SMITH222", { title: "On Testing", date: "2023", creators: [{ creatorType: "author", firstName: "John", lastName: "Smith" }] }),
      article("PAIR2222", { title: "Pair Paper", date: "2019-03-01", creators: [
        { creatorType: "author", firstName: "Jane", lastName: "Doe" },
        { creatorType: "author", firstName: "Rick", lastName: "Roe" },
      ] }),
    ];
    const h = await startHarness();
    try {
      h.net.on("GET", `${ZBASE}/items`, zLibraryQuery(items));
      for (const it of items) h.net.on("GET", `${ZBASE}/items/${it.key}`, zSingle(it));
      const details = await h.call("get_items_details", { item_keys: items.map((i) => i.key) });
      const metaPath = await dir.file("meta-pandoc.json", JSON.stringify(details.json));

      const body = para("See [@SMITH222] and also [see @SMITH222; @PAIR2222, p. 3].");
      const forTool = await dir.file("pan-tool.docx", await makeDocx(body));
      const forScript = await dir.file("pan-script.docx", await makeDocx(body));

      const tool = await h.call("inject_citations", { file_path: forTool });
      expect(tool.isError, tool.text).toBe(false);
      expect(tool.json).toMatchObject({ citations_found: 2, citations_injected: 2 });
      const out = join(dir.path, "pan-script-out.docx");
      const r = await run([forScript, out, metaPath, "424242"]);
      expect(r.code, r.stderr).toBe(0);

      const strip = (cites: Array<Record<string, any>>) =>
        cites.map((c) => ({ text: c.properties.formattedCitation, items: c.citationItems.map((ci: any) => ({ uris: ci.uris, itemData: ci.itemData })) }));
      const toolXml = await readDocumentXml(await readFile(tool.json.output_path));
      const scriptXml = await readDocumentXml(await readFile(out));
      expect(strip(citations(scriptXml))).toEqual(strip(citations(toolXml)));
      expect(scriptXml).toContain("ADDIN ZOTERO_BIBL");
      expect(toolXml).toContain("ADDIN ZOTERO_BIBL");
      await expectValidDocx(await readFile(out));
    } finally {
      await h.close();
    }
  });

  it("SK-P02 misto <zcite> + [@KEY], poi seconda chiamata sul _cited: tool e script identici, una sola bibliografia", async () => {
    const items = [
      article("SMITH222", { title: "On Testing", date: "2023", creators: [{ creatorType: "author", firstName: "John", lastName: "Smith" }] }),
      article("PAIR2222", { title: "Pair Paper", date: "2019", creators: [{ creatorType: "author", firstName: "Jane", lastName: "Doe" }] }),
    ];
    const h = await startHarness();
    try {
      h.net.on("GET", `${ZBASE}/items`, zLibraryQuery(items));
      for (const it of items) h.net.on("GET", `${ZBASE}/items/${it.key}`, zSingle(it));
      const metaPath = await dir.file("meta-mixed.json", JSON.stringify((await h.call("get_items_details", { item_keys: items.map((i) => i.key) })).json));

      const body = para("Zotero ") + para("Z ", zcite({ keys: "SMITH222" }), " and pandoc [@PAIR2222].");
      const toolIn = await dir.file("mix-tool.docx", await makeDocx(body));
      const scriptIn = await dir.file("mix-script.docx", await makeDocx(body));

      // prima passata: ramo zcite (entrambi i produttori)
      const toolMid = (await h.call("inject_citations", { file_path: toolIn })).json.output_path as string;
      const scriptMid = join(dir.path, "mix-script_mid.docx");
      expect((await run([scriptIn, scriptMid, metaPath, "424242"])).code).toBe(0);

      // seconda passata sul _cited: ramo pandoc inietta il [@PAIR2222] rimasto
      const toolOut = (await h.call("inject_citations", { file_path: toolMid })).json.output_path as string;
      const scriptOut = join(dir.path, "mix-script_final.docx");
      expect((await run([scriptMid, scriptOut, metaPath, "424242"])).code).toBe(0);

      const strip = (cites: Array<Record<string, any>>) =>
        cites.map((c) => ({ text: c.properties.formattedCitation, items: c.citationItems.map((ci: any) => ({ uris: ci.uris, itemData: ci.itemData })) }));
      const toolXml = await readDocumentXml(await readFile(toolOut));
      const scriptXml = await readDocumentXml(await readFile(scriptOut));
      expect(strip(citations(scriptXml))).toEqual(strip(citations(toolXml)));
      expect((toolXml.match(/ADDIN ZOTERO_BIBL/g) ?? []).length).toBe(1);
      expect((scriptXml.match(/ADDIN ZOTERO_BIBL/g) ?? []).length).toBe(1);
      await expectValidDocx(await readFile(scriptOut));
    } finally {
      await h.close();
    }
  });

  it("SK-10 tesi, report, preprint, pagina web, libro: università, istituzione, repository, numero, genere, data di accesso, ISBN/ISSN/edizione/lingua/pagine, data non numerica → stessi itemData di inject_citations", async () => {
    const items = [
      { key: "THESIS22", itemType: "thesis", title: "A thesis", date: "2022", university: "University of Bologna", thesisType: "PhD thesis", numPages: "210", language: "en", creators: [{ creatorType: "author", firstName: "Ada", lastName: "Gualandi" }] },
      { key: "REPRT222", itemType: "report", title: "A report", date: "2020-06", institution: "Research Data Alliance", reportNumber: "RDA-50", reportType: "Specification", creators: [{ creatorType: "author", name: "Working Group" }] },
      { key: "PRPRNT22", itemType: "preprint", title: "A preprint", date: "2023-10-10", repository: "arXiv", archiveID: "arXiv:2310.06825", creators: [{ creatorType: "author", firstName: "Albert", lastName: "Jiang" }] },
      { key: "WEBPAGE2", itemType: "webpage", title: "A page", websiteTitle: "The Site", url: "https://example.org/p", accessDate: "2026-10-21T08:00:00Z", creators: [{ creatorType: "author", name: "Site Community" }] },
      { key: "BKEDTN22", itemType: "book", title: "A book", date: "October 2023", publisher: "Press", ISBN: "978-1-78374-238-7", edition: "2", creators: [{ creatorType: "author", firstName: "Jo", lastName: "Kochan" }] },
      article("JRNLSSN2", { title: "A journal article", date: "2021", ISSN: "1864-8312", publicationTitle: "Arthropod Systematics & Phylogeny" }),
    ];
    const h = await startHarness();
    try {
      h.net.on("GET", `${ZBASE}/items`, zLibraryQuery(items));
      for (const it of items) h.net.on("GET", `${ZBASE}/items/${it.key}`, zSingle(it));
      const details = await h.call("get_items_details", { item_keys: items.map((i) => i.key) });
      const metaPath = await dir.file("meta-fields.json", JSON.stringify(details.json));
      const body = items.map((i) => para(zcite({ keys: i.key }))).join("");
      const forTool = await dir.file("fields-tool.docx", await makeDocx(body));
      const forScript = await dir.file("fields-script.docx", await makeDocx(body));
      const tool = await h.call("inject_citations", { file_path: forTool });
      expect(tool.isError, tool.text).toBe(false);
      const out = join(dir.path, "fields-script-out.docx");
      const r = await run([forScript, out, metaPath, "424242"]);
      expect(r.code, r.stderr).toBe(0);
      const data = async (path: string) => citations(await readDocumentXml(await readFile(path))).map((c) => c.citationItems[0].itemData);
      const fromTool = await data(tool.json.output_path);
      const fromScript = await data(out);
      expect(fromScript).toEqual(fromTool);
      expect(fromTool[0]).toMatchObject({ type: "thesis", publisher: "University of Bologna", genre: "PhD thesis", "number-of-pages": "210", language: "en" });
      expect(fromTool[1]).toMatchObject({ type: "report", publisher: "Research Data Alliance", number: "RDA-50", genre: "Specification" });
      expect(fromTool[2]).toMatchObject({ type: "article", publisher: "arXiv", number: "arXiv:2310.06825" });
      expect(fromTool[3]).toMatchObject({ type: "webpage", "container-title": "The Site", accessed: { "date-parts": [[2026, 10, 21]] } });
      expect(fromTool[4]).toMatchObject({ issued: { raw: "October 2023" }, ISBN: "978-1-78374-238-7", edition: "2" });
      expect(fromTool[5]).toMatchObject({ ISSN: "1864-8312", "container-title": "Arthropod Systematics & Phylogeny" });
      await expectValidDocx(await readFile(out));
      await expectValidDocx(await readFile(tool.json.output_path));
    } finally {
      await h.close();
    }
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

  // Trovato dalla suite dal vivo (LIVE-SK-01): get_items_details restituisce il campo Zotero `place`,
  // che inject.js prima ignorava (leggeva solo `publisherPlace`).
  it("SK-09 place da get_items_details → itemData publisher-place come inject_citations", async () => {
    const placed = await dir.file("meta-place.json", JSON.stringify({ PLACE222: { itemType: "book", title: "Placed Book", authors: "Jane Doe", date: "2020", publisher: "Press", place: "Rome" } }));
    const src = await dir.file("place.docx", await makeDocx(para(zcite({ keys: "PLACE222" }))));
    const out = join(dir.path, "place-out.docx");
    expect((await run([src, out, placed, "424242"])).code).toBe(0);
    const [c] = citations(await readDocumentXml(await readFile(out)));
    expect(c.citationItems[0].itemData["publisher-place"]).toBe("Rome");
  });

  describe("validazione docx (SK-V)", () => {
    const BODY = (numbered: boolean) =>
      para("A ", zcite({ keys: "SMITH222", ...(numbered && { num: "1" }) })) +
      para("B ", zcite({ keys: "PAIR2222,SMITH222", locator: "p. 3", prefix: "see ", ...(numbered && { num: "2,1" }) })) +
      para("C ", zcite({ keys: "PAIR2222", ...(numbered && { num: "2" }) }));

    it.each<CitationStyle>(["apa", "harvard", "chicago", "ieee", "vancouver"])(
      "SK-V01 stile %s: output di inject.js valido (struttura, schema, URI, citeproc, parti chiave)",
      async (style) => {
        const numbered = style === "ieee" || style === "vancouver";
        const src = await dir.file(`skv-${style}.docx`, await makeDocx(BODY(numbered)));
        const out = join(dir.path, `skv-${style}-out.docx`);
        const r = await run([src, out, meta, "424242", style]);
        expect(r.code).toBe(0);
        expect(r.stderr).not.toContain("WARNING");
        const report = await expectValidDocx(await readFile(out), { style, libraryPath: "users/424242" });
        expect(report.rendered!.bibliography).toHaveLength(2);
        // same document preferences as inject_citations (H-W1): the injected style, fieldType Field
        expect(report.documentPrefs).toEqual({ styleId: styleId(style), fieldType: "Field", chunks: 1 });
      }
    );

    it("SK-V03 preferenze Zotero già presenti → mantenute con WARNING; radice con prefisso → unite, proprietà dell'utente conservate (come inject_citations)", async () => {
      const NS = "http://schemas.openxmlformats.org/officeDocument/2006/custom-properties";
      const withCustom = async (name: string, custom: string) => {
        const zip = await JSZip.loadAsync(await makeDocx(BODY(false)));
        zip.file("docProps/custom.xml", custom);
        return dir.file(name, await zip.generateAsync({ type: "nodebuffer" }));
      };
      const kept = `<?xml version="1.0"?><Properties xmlns="${NS}" xmlns:vt="v"><property pid='2' name='ZOTERO_PREF_1'><vt:lpwstr>KEEP</vt:lpwstr></property></Properties>`;
      let out = join(dir.path, "skv-kept-out.docx");
      let r = await run([await withCustom("skv-kept.docx", kept), out, meta, "424242", "apa"]);
      expect(r.code).toBe(0);
      expect(r.stderr).toContain("WARNING: The document already has Zotero document preferences");
      expect(await (await JSZip.loadAsync(await readFile(out))).file("docProps/custom.xml")!.async("string")).toBe(kept);
      const own = '<op:property fmtid="{D5CDD505-2E9C-101B-9397-08002B2CF9AE}" pid="2" name="Client"><vt:lpwstr>ACME</vt:lpwstr></op:property>';
      out = join(dir.path, "skv-prefixed-out.docx");
      r = await run([await withCustom("skv-prefixed.docx", `<?xml version="1.0"?><op:Properties xmlns:op="${NS}" xmlns:vt="v">${own}</op:Properties>`), out, meta, "424242", "apa"]);
      expect(r.code).toBe(0);
      expect(r.stderr).not.toContain("WARNING");
      const custom = await (await JSZip.loadAsync(await readFile(out))).file("docProps/custom.xml")!.async("string");
      expect(custom).toContain(own);
      expect(custom).toMatch(/<op:property [^>]*pid="3" name="ZOTERO_PREF_1">/);
      // a custom properties part that cannot be merged into: left intact, preferences not written, WARNING
      const odd = '<?xml version="1.0"?><x:Other xmlns:x="y"/>';
      out = join(dir.path, "skv-odd-out.docx");
      r = await run([await withCustom("skv-odd.docx", odd), out, meta, "424242", "apa"]);
      expect(r.code).toBe(0);
      expect(r.stderr).toContain("WARNING: Zotero document preferences not written");
      expect(await (await JSZip.loadAsync(await readFile(out))).file("docProps/custom.xml")!.async("string")).toBe(odd);
    });

    it("SK-V02 libreria groups/<id> → URI di gruppo validi", async () => {
      const out = join(dir.path, "skv-group-out.docx");
      expect((await run([input, out, meta, "groups/777"])).code).toBe(0);
      await expectValidDocx(await readFile(out), { libraryPath: "groups/777" });
    });
  });
});
