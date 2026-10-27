import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { XMLValidator } from "fast-xml-parser";
import { Harness, startHarness, expectToolError } from "../helpers/mcp-harness.js";
import { ZBASE, zSingle, zList, zError, article, USER_ID } from "../helpers/zotero-fake.js";
import { makeDocx, para, readDocumentXml, makeOdt, odtPara, odtSpan, readContentXml, zcite, tempDir, TempDir } from "../helpers/fixtures.js";
import { itemMatchesCitekey } from "../../src/citation-injector/citekey-resolver.js";

/**
 * IC-P*: ramo Pandoc di inject_citations. Un documento senza <zcite> ma con marcatori `[@key]` (o inline
 * `@key`) viene iniettato come i tag zcite; i citekey Better BibTeX sono risolti in chiavi Zotero via
 * ricerca (campo citationKey o riga "Citation Key:" in Extra). Il ramo zcite non è toccato (golden a parte).
 */

const ITEM_ROUTE = new RegExp(`^${ZBASE.replace(/\./g, "\\.")}/items/[A-Z0-9]+$`);

const SMITH = article("SMITH222", {
  title: "On Testing",
  creators: [{ creatorType: "author", firstName: "John", lastName: "Smith" }],
  date: "2023",
});
const DOE = article("DEEE2222", {
  title: "Doe Paper",
  creators: [{ creatorType: "author", firstName: "Jane", lastName: "Doe" }],
  date: "2019",
});
/** Item con citekey nativo BBT. */
const ROSSI = article("RSSI2345", {
  title: "Rossi Work",
  creators: [{ creatorType: "author", firstName: "Mario", lastName: "Rossi" }],
  date: "2020",
  citationKey: "rossi2020",
});
/** Item con citekey nella riga Extra. */
const BIANCHI = article("BNCH2345", {
  title: "Bianchi Study",
  creators: [{ creatorType: "author", firstName: "Lucia", lastName: "Bianchi" }],
  date: "2021",
  extra: "tex.ids: x\nCitation Key: bianchi2021\nOther: y",
});

/** GET /items/KEY (risoluzione CSL per chiave, come zoteroItemSource). */
function serveItems(h: Harness, items: Record<string, Record<string, unknown>>) {
  h.net.on("GET", ITEM_ROUTE, (req) => {
    const key = req.url.pathname.split("/").pop()!;
    const item = items[key];
    return item ? zSingle({ key, ...item }) : zError(404, "Item not found");
  });
}

/** GET /items?q=<citekey>&qmode=everything → le voci che portano quel citekey (campo o Extra). */
function serveSearch(h: Harness, items: Record<string, Record<string, unknown>>) {
  h.net.on("GET", `${ZBASE}/items`, (req) => {
    const q = req.url.searchParams.get("q") ?? "";
    const matched = Object.entries(items)
      .filter(([, it]) => itemMatchesCitekey(it, q))
      .map(([key, it]) => ({ key, ...it }));
    return zList(matched);
  });
}

describe("inject_citations: marcatori Pandoc (IC-P*)", () => {
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

  it("IC-P01 [@KEY] con chiave Zotero → field code + bibliografia, nessun <zcite>", async () => {
    serveItems(h, { SMITH222: SMITH });
    const input = await dir.file("p.docx", await makeDocx(para("As shown [@SMITH222] here.")));
    const out = await h.call("inject_citations", { file_path: input });
    expect(out.isError, out.text).toBe(false);
    expect(out.json).toMatchObject({ output_path: join(dir.path, "p_cited.docx"), citations_found: 1, citations_injected: 1 });
    const xml = await readDocumentXml(await readFile(out.json.output_path));
    expect(XMLValidator.validate(xml)).toBe(true);
    expect(xml).toContain("ADDIN ZOTERO_ITEM CSL_CITATION");
    expect(xml).toContain("ADDIN ZOTERO_BIBL");
    expect(xml).toContain("(Smith, 2023)");
    expect(xml).toContain("As shown ");
    expect(xml).toContain(" here.");
    expect(xml).not.toContain("[@SMITH222]");
  });

  it("IC-P02 inline @KEY e soppressione autore -@KEY", async () => {
    serveItems(h, { SMITH222: SMITH });
    const input = await dir.file("p.docx", await makeDocx(para("See @SMITH222 and -@SMITH222 end.")));
    const out = await h.call("inject_citations", { file_path: input });
    expect(out.json).toMatchObject({ citations_found: 2, citations_injected: 2 });
    const xml = await readDocumentXml(await readFile(out.json.output_path));
    expect(xml).not.toMatch(/[^A-Za-z0-9]@SMITH222/);
    expect(xml).toContain("ADDIN ZOTERO_ITEM CSL_CITATION");
  });

  it("IC-P03 marcatore spezzato tra due run → unito e iniettato", async () => {
    serveItems(h, { SMITH222: SMITH });
    const input = await dir.file("p.docx", await makeDocx(para("Start [@", "SMITH222", "] end.")));
    const out = await h.call("inject_citations", { file_path: input });
    expect(out.json).toMatchObject({ citations_found: 1, citations_injected: 1 });
    const xml = await readDocumentXml(await readFile(out.json.output_path));
    expect(xml).not.toContain("[@");
    expect(xml).toContain("(Smith, 2023)");
  });

  it("IC-P04 citekey Better BibTeX risolto dal campo citationKey", async () => {
    serveSearch(h, { RSSI2345: ROSSI });
    serveItems(h, { RSSI2345: ROSSI });
    const input = await dir.file("p.docx", await makeDocx(para("As in [@rossi2020].")));
    const out = await h.call("inject_citations", { file_path: input });
    expect(out.isError, out.text).toBe(false);
    expect(out.json).toMatchObject({ citations_found: 1, citations_injected: 1 });
    const xml = await readDocumentXml(await readFile(out.json.output_path));
    expect(xml).toContain("(Rossi, 2020)");
    expect(xml).toContain("/items/RSSI2345");
    expect(xml).not.toContain("rossi2020");
  });

  it("IC-P05 citekey risolto dalla riga 'Citation Key:' in Extra", async () => {
    serveSearch(h, { BNCH2345: BIANCHI });
    serveItems(h, { BNCH2345: BIANCHI });
    const input = await dir.file("p.docx", await makeDocx(para("See [@bianchi2021, p. 12].")));
    const out = await h.call("inject_citations", { file_path: input });
    expect(out.json).toMatchObject({ citations_found: 1, citations_injected: 1 });
    const xml = await readDocumentXml(await readFile(out.json.output_path));
    expect(xml).toContain("/items/BNCH2345");
    expect(xml).toContain("p. 12");
  });

  it("IC-P06 citekey sconosciuto → errore, nessun file", async () => {
    serveSearch(h, { RSSI2345: ROSSI });
    serveItems(h, { RSSI2345: ROSSI });
    const input = await dir.file("p.docx", await makeDocx(para("Missing [@nope9999].")));
    expectToolError(await h.call("inject_citations", { file_path: input }), /not found in the library.*nope9999|nope9999.*not found/);
    await expect(readFile(join(dir.path, "p_cited.docx"))).rejects.toThrow();
  });

  it("IC-P07 citekey ambiguo (due voci) → errore, nessun file", async () => {
    const dup = article("DUPL2345", { title: "Dup", creators: [{ creatorType: "author", lastName: "Z" }], date: "2020", citationKey: "rossi2020" });
    serveSearch(h, { RSSI2345: ROSSI, DUPL2345: dup });
    const input = await dir.file("p.docx", await makeDocx(para("Ambiguous [@rossi2020].")));
    expectToolError(await h.call("inject_citations", { file_path: input }), /match more than one item/);
  });

  it("IC-P08 una email non è una citazione", async () => {
    serveItems(h, { SMITH222: SMITH });
    const input = await dir.file("p.docx", await makeDocx(para("Write to a@b.com then cite [@SMITH222].")));
    const out = await h.call("inject_citations", { file_path: input });
    expect(out.json).toMatchObject({ citations_found: 1, citations_injected: 1 });
    const xml = await readDocumentXml(await readFile(out.json.output_path));
    expect(xml).toContain("a@b.com");
    expect(xml).toContain("(Smith, 2023)");
  });

  it("IC-P09 stile numerico ieee: numerazione per ordine di prima citazione", async () => {
    serveItems(h, { SMITH222: SMITH, DEEE2222: DOE });
    const input = await dir.file("p.docx", await makeDocx(para("First [@SMITH222] then [@DEEE2222] then [@SMITH222].")));
    const out = await h.call("inject_citations", { file_path: input, style: "ieee" });
    expect(out.json).toMatchObject({ citations_found: 3, citations_injected: 3 });
    const xml = await readDocumentXml(await readFile(out.json.output_path));
    expect(xml).toContain("[1]");
    expect(xml).toContain("[2]");
  });

  it("IC-P10 documento misto zcite + [@…]: vince zcite, i marcatori Pandoc restano testo, con avviso", async () => {
    serveItems(h, { SMITH222: SMITH, DEEE2222: DOE });
    const body = para("Zotero ", zcite({ keys: "SMITH222" }), " and pandoc [@DEEE2222].");
    const input = await dir.file("p.docx", await makeDocx(body));
    const out = await h.call("inject_citations", { file_path: input });
    expect(out.json).toMatchObject({ citations_found: 1, citations_injected: 1 });
    expect((out.json.warnings ?? []).join(" ")).toMatch(/1 Pandoc citation marker/);
    const xml = await readDocumentXml(await readFile(out.json.output_path));
    expect(xml).toContain("(Smith, 2023)");
    expect(xml).toContain("[@DEEE2222]"); // lasciato come testo
  });

  it("IC-P11 seconda chiamata sul _cited: inietta i Pandoc rimasti, nessuna seconda bibliografia", async () => {
    serveItems(h, { SMITH222: SMITH, DEEE2222: DOE });
    const body = para("Zotero ", zcite({ keys: "SMITH222" }), " and pandoc [@DEEE2222].");
    const input = await dir.file("mix.docx", await makeDocx(body));
    const first = await h.call("inject_citations", { file_path: input });
    expect(first.json.citations_injected).toBe(1);

    const second = await h.call("inject_citations", { file_path: first.json.output_path });
    expect(second.json).toMatchObject({ citations_found: 1, citations_injected: 1 });
    expect((second.json.warnings ?? []).join(" ")).toMatch(/already has a Zotero bibliography/);
    const xml = await readDocumentXml(await readFile(second.json.output_path));
    expect((xml.match(/ADDIN ZOTERO_BIBL/g) ?? []).length).toBe(1);
    expect(xml).toContain("(Doe, 2019)");
    expect(xml).not.toContain("[@DEEE2222]");
  });

  it("IC-P12 ODT: [@KEY] → reference mark + sezione bibliografia", async () => {
    serveItems(h, { SMITH222: SMITH });
    const input = await dir.file("p.odt", await makeOdt(odtPara("As shown [@SMITH222] here.")));
    const out = await h.call("inject_citations", { file_path: input });
    expect(out.isError, out.text).toBe(false);
    expect(out.json).toMatchObject({ output_path: join(dir.path, "p_cited.odt"), citations_found: 1, citations_injected: 1 });
    const xml = await readContentXml(await readFile(out.json.output_path));
    expect(xml).toContain("text:reference-mark-start");
    expect(xml).toContain("ZOTERO_BIBL");
    expect(xml).not.toContain("[@SMITH222]");
  });

  it("IC-P13 ODT: marcatore spezzato tra due span → unito e iniettato", async () => {
    serveItems(h, { SMITH222: SMITH });
    const input = await dir.file("p.odt", await makeOdt(odtPara("See ", odtSpan("[@"), odtSpan("SMITH222]"), " end.")));
    const out = await h.call("inject_citations", { file_path: input });
    expect(out.json).toMatchObject({ citations_found: 1, citations_injected: 1 });
    const xml = await readContentXml(await readFile(out.json.output_path));
    expect(xml).toContain("text:reference-mark-start");
    expect(xml).not.toContain("[@");
  });

  it("IC-P14 nessun marcatore (né zcite né Pandoc) → copia invariata, avviso", async () => {
    serveItems(h, { SMITH222: SMITH });
    const input = await dir.file("p.docx", await makeDocx(para("Plain text, no citations.")));
    const out = await h.call("inject_citations", { file_path: input });
    expect(out.json).toMatchObject({ citations_found: 0, citations_injected: 0 });
    expect((out.json.warnings ?? []).join(" ")).toMatch(/No <zcite> placeholders found/);
    const xml = await readDocumentXml(await readFile(out.json.output_path));
    expect(xml).not.toContain("ADDIN ZOTERO");
  });

  it("IC-P15 [@K1; @K2] più voci in una citazione", async () => {
    serveItems(h, { SMITH222: SMITH, DEEE2222: DOE });
    const input = await dir.file("p.docx", await makeDocx(para("Both [@SMITH222; @DEEE2222].")));
    const out = await h.call("inject_citations", { file_path: input });
    expect(out.json).toMatchObject({ citations_found: 1, citations_injected: 1 });
    const xml = await readDocumentXml(await readFile(out.json.output_path));
    expect(xml).toContain("/items/SMITH222");
    expect(xml).toContain("/items/DEEE2222");
  });

  it("IC-P16 solo handle/codice inline (nessuna citazione) → copia invariata, NESSUN errore", async () => {
    serveSearch(h, {}); // ogni ricerca citekey torna vuota
    const input = await dir.file("p.docx", await makeDocx(para("Use @Component and @media and @app.route here.")));
    const out = await h.call("inject_citations", { file_path: input });
    expect(out.isError, out.text).toBe(false);
    expect(out.json).toMatchObject({ citations_found: 0, citations_injected: 0 });
    expect((out.json.warnings ?? []).join(" ")).toMatch(/kept as text/);
    const xml = await readDocumentXml(await readFile(out.json.output_path));
    expect(xml).toContain("@Component");
    expect(xml).not.toContain("ADDIN ZOTERO");
  });

  it("IC-P17 handle non risolto accanto a un [@KEY] reale → inietta la citazione, l'handle resta testo", async () => {
    serveItems(h, { SMITH222: SMITH });
    serveSearch(h, {});
    const input = await dir.file("p.docx", await makeDocx(para("Ping @handle then cite [@SMITH222].")));
    const out = await h.call("inject_citations", { file_path: input });
    expect(out.json).toMatchObject({ citations_found: 1, citations_injected: 1 });
    expect((out.json.warnings ?? []).join(" ")).toMatch(/@handle.*kept as text/);
    const xml = await readDocumentXml(await readFile(out.json.output_path));
    expect(xml).toContain("@handle");
    expect(xml).toContain("(Smith, 2023)");
  });

  it("IC-P18 seconda chiamata: una '@' nel titolo di un campo esistente non blocca l'iniezione del nuovo [@KEY]", async () => {
    const smithAt = article("SMITH222", {
      title: "Note @handle in title",
      creators: [{ creatorType: "author", firstName: "John", lastName: "Smith" }],
      date: "2023",
    });
    serveItems(h, { SMITH222: smithAt, DEEE2222: DOE });
    const body = para("Zotero ", zcite({ keys: "SMITH222" }), " and pandoc [@DEEE2222].");
    const input = await dir.file("mix.docx", await makeDocx(body));
    const first = await h.call("inject_citations", { file_path: input });
    expect(first.json.citations_injected).toBe(1);
    // il campo iniettato ora contiene "@handle" nel suo instrText (CSL JSON del titolo)
    const firstXml = await readDocumentXml(await readFile(first.json.output_path));
    expect(firstXml).toContain("@handle");

    const second = await h.call("inject_citations", { file_path: first.json.output_path });
    expect(second.isError, second.text).toBe(false);
    expect(second.json).toMatchObject({ citations_found: 1, citations_injected: 1 });
    const xml = await readDocumentXml(await readFile(second.json.output_path));
    expect(xml).toContain("/items/DEEE2222");
    expect(xml).not.toContain("[@DEEE2222]");
  });

  it("IC-P19 inline spezzato tra due run non viene ricucito → resta testo con avviso, nessun errore", async () => {
    serveSearch(h, {});
    const input = await dir.file("p.docx", await makeDocx(para("See @SMI", "TH222 end.")));
    const out = await h.call("inject_citations", { file_path: input });
    expect(out.isError, out.text).toBe(false);
    expect(out.json).toMatchObject({ citations_found: 0, citations_injected: 0 });
    expect((out.json.warnings ?? []).join(" ")).toMatch(/kept as text/);
    const xml = await readDocumentXml(await readFile(out.json.output_path));
    expect(xml).toContain("@SMI");
    expect(xml).not.toContain("ADDIN ZOTERO");
  });
});
