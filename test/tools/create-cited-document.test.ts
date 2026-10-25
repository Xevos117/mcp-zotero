import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Harness, startHarness, expectErrorJson, expectToolError } from "../helpers/mcp-harness.js";
import { ZBASE, zSingle, zError, article, USER_ID } from "../helpers/zotero-fake.js";
import { readDocumentXml, readContentXml, tempDir, TempDir } from "../helpers/fixtures.js";
import { citations, expectValidDocx, CitationStyle } from "../helpers/docx-validate.js";
import { expectValidOdt } from "../helpers/citation-validate.js";

const ITEM_ROUTE = new RegExp(`^${ZBASE.replace(/\./g, "\\.")}/items/[A-Z0-9]+$`);
function serveItems(h: Harness, items: Record<string, Record<string, unknown>>) {
  h.net.on("GET", ITEM_ROUTE, (req) => {
    const key = req.url.pathname.split("/").pop()!;
    const it = items[key];
    return it ? zSingle({ key, ...it }) : zError(404, "Item not found");
  });
}
const SMITH = article("SMITH222", { title: "On Testing", creators: [{ creatorType: "author", firstName: "John", lastName: "Smith" }], date: "2023" });
const PAIR = article("PAIR2222", { title: "Pair Paper", creators: [{ creatorType: "author", firstName: "Jane", lastName: "Doe" }, { creatorType: "author", firstName: "Rick", lastName: "Roe" }], date: "2019" });

const MD = "# Introduction\n\nA claim with **bold** and *italic* [@SMITH222].\n\n- point one [@PAIR2222]\n- point two\n\nSee also [see @SMITH222, p. 12].";

describe("create_cited_document (CCD)", () => {
  let h: Harness;
  let dir: TempDir;
  beforeEach(async () => {
    h = await startHarness();
    dir = await tempDir();
  });
  afterEach(async () => {
    await h.close();
    await dir.cleanup();
  });

  it("CCD-01 markdown → docx con titoli, grassetto/corsivo, elenco, citazioni, bibliografia", async () => {
    serveItems(h, { SMITH222: SMITH, PAIR2222: PAIR });
    const out = join(dir.path, "doc.docx");
    const res = await h.call("create_cited_document", { markdown: MD, output_path: out });
    expect(res.isError, res.text).toBe(false);
    expect(res.json).toMatchObject({ output_path: out, citations: 3 });
    const xml = await readDocumentXml(await readFile(out));
    expect(xml).toContain("ADDIN ZOTERO_ITEM CSL_CITATION");
    expect(xml).toContain("ADDIN ZOTERO_BIBL");
    expect(xml).toContain('<w:pStyle w:val="Heading1"/>'); // titolo con stile vero
    expect(xml).toContain("<w:b/>");
    expect(xml).toContain("<w:i/>");
    expect(xml).toContain("•"); // elenco
    await expectValidDocx(await readFile(out), { libraryPath: `users/${USER_ID}` });
  });

  it("CCD-02 markdown → odt con reference mark e bibliografia", async () => {
    serveItems(h, { SMITH222: SMITH, PAIR2222: PAIR });
    const out = join(dir.path, "doc.odt");
    const res = await h.call("create_cited_document", { markdown: MD, output_path: out });
    expect(res.isError, res.text).toBe(false);
    const xml = await readContentXml(await readFile(out));
    expect(xml).toContain("text:reference-mark-start");
    expect(xml).toContain('text:style-name="Heading_20_1"'); // titolo con stile vero
    expect(xml).toContain('text:style-name="T_Bold"');
    await expectValidOdt(await readFile(out), { libraryPath: `users/${USER_ID}` });
  });

  it.each<CitationStyle>(["apa", "ieee"])("CCD-03 stile %s valido (ieee: numeri in ordine di prima citazione)", async (style) => {
    serveItems(h, { SMITH222: SMITH, PAIR2222: PAIR });
    const out = join(dir.path, `s-${style}.docx`);
    const res = await h.call("create_cited_document", { markdown: MD, output_path: out, style });
    expect(res.isError, res.text).toBe(false);
    const r = await expectValidDocx(await readFile(out), { style });
    if (style === "ieee") {
      // SMITH222 è la prima chiave citata → [1], PAIR2222 la seconda → [2]
      const cs = citations(await readDocumentXml(await readFile(out)));
      expect(cs[0].properties.formattedCitation).toBe("[1]");
      expect(cs[1].properties.formattedCitation).toBe("[2]");
    }
    expect(r.citations.length).toBeGreaterThan(0);
  });

  it("CCD-04 output già esistente → errore, non sovrascritto", async () => {
    serveItems(h, { SMITH222: SMITH });
    const out = join(dir.path, "exists.docx");
    await writeFile(out, "KEEP");
    const res = await h.call("create_cited_document", { markdown: "A [@SMITH222].", output_path: out });
    const json = expectErrorJson(res, "already exists");
    expect(json.output_path).toBe(out);
    expect((await readFile(out)).toString()).toBe("KEEP");
  });

  it("CCD-05 chiave non valida per Zotero → errore come inject_citations, nessun output", async () => {
    const out = join(dir.path, "bad.docx");
    const res = await h.call("create_cited_document", { markdown: "A [@abcd2345].", output_path: out });
    expectToolError(res, "Invalid Zotero item key(s) in <zcite>: abcd2345");
    await expect(readFile(out)).rejects.toThrow();
  });

  it("CCD-06 chiave assente dalla libreria → errore, nessun output", async () => {
    serveItems(h, { SMITH222: SMITH });
    const out = join(dir.path, "missing.docx");
    const res = await h.call("create_cited_document", { markdown: "A [@MISS2222].", output_path: out });
    expectToolError(res, "1 cited key(s) not found in the library: MISS2222");
    await expect(readFile(out)).rejects.toThrow();
  });

  it("CCD-07 format in contrasto con l'estensione → errore", async () => {
    const res = await h.call("create_cited_document", { markdown: "x", output_path: join(dir.path, "a.docx"), format: "odt" });
    expectErrorJson(res, "does not match the output extension");
  });

  it("CCD-09 -@K (suppress-author): solo l'anno nel testo e in citeproc, suppress-author nel field JSON", async () => {
    serveItems(h, { SMITH222: SMITH });
    const out = join(dir.path, "suppress.docx");
    const res = await h.call("create_cited_document", { markdown: "As shown [-@SMITH222], it works.", output_path: out });
    expect(res.isError, res.text).toBe(false);
    const cs = citations(await readDocumentXml(await readFile(out)));
    expect(cs[0].citationItems[0]["suppress-author"]).toBe(true);
    expect(cs[0].properties.formattedCitation).toBe("(2023)");
    // citeproc con suppress-author rende "(2023)" (senza "Smith"): nessuna differenza
    const r = await expectValidDocx(await readFile(out), { style: "apa" });
    expect(r.rendered!.citations[0]).not.toContain("Smith");
    expect(r.rendered!.citations[0]).toContain("2023");
  });

  it("CCD-08 nessuna citazione → documento creato senza bibliografia", async () => {
    const out = join(dir.path, "plain.docx");
    const res = await h.call("create_cited_document", { markdown: "# Just a title\n\nNo citations.", output_path: out });
    expect(res.isError, res.text).toBe(false);
    expect(res.json).toMatchObject({ citations: 0 });
    const xml = await readDocumentXml(await readFile(out));
    expect(xml).not.toContain("ADDIN ZOTERO_BIBL");
    expect(xml).toContain("Just a title");
  });
});
