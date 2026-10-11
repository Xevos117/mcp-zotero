import { describe, it, expect } from "vitest";
import JSZip from "jszip";
import { generateZoteroFieldCode, generateBibliographyFieldCode } from "../../src/citation-injector/field-codes.js";
import { escapeXml } from "../../src/citation-injector/xml-utils.js";
import { makeDocx, documentXml } from "../helpers/fixtures.js";
import { validateDocx, expectValidDocx, citationNumbers, citations, CitationStyle } from "../helpers/docx-validate.js";

/**
 * Il validatore deve accettare l'output del prodotto e rifiutare i docx rotti: ogni caso negativo
 * altera un docx valido in un solo punto e controlla che l'errore venga segnalato.
 */

const URI_A = "http://zotero.org/users/424242/items/SMITH001";
const URI_B = "http://zotero.org/users/424242/items/DOEROE01";
const SMITH = { type: "article-journal", title: "On Testing", author: [{ family: "Smith", given: "John" }], issued: { "date-parts": [[2023]] } };
const DOE_ROE = {
  type: "book",
  title: "Pair Book",
  author: [{ family: "Doe", given: "Jane" }, { family: "Roe", given: "Rick" }],
  issued: { "date-parts": [[2019, 3, 1]] },
};

function item(uri: string, itemData: Record<string, unknown>, id = 0, extra: Record<string, unknown> = {}) {
  return { id, uris: [uri], uri: [uri], itemData, ...extra } as any;
}

/** Corpo con due citazioni prodotte da generateZoteroFieldCode e la bibliografia. */
function goodBody(texts: [string, string] = ["(Smith, 2023)", "(Smith, 2023; Doe & Roe, 2019)"]): string {
  return (
    `<w:p><w:r><w:t>A </w:t></w:r>${generateZoteroFieldCode([item(URI_A, SMITH)], texts[0])}</w:p>` +
    `<w:p>${generateZoteroFieldCode([item(URI_A, SMITH), item(URI_B, DOE_ROE, 1)], texts[1])}</w:p>` +
    generateBibliographyFieldCode()
  );
}

async function withPart(base: Buffer, name: string, content: string | null): Promise<Buffer> {
  const zip = await JSZip.loadAsync(base);
  if (content === null) zip.remove(name);
  else zip.file(name, content);
  return zip.generateAsync({ type: "nodebuffer" });
}

function rawField(instr: string, visible: string): string {
  return (
    '<w:r><w:fldChar w:fldCharType="begin"/></w:r>' +
    `<w:r><w:instrText xml:space="preserve">${escapeXml(instr)}</w:instrText></w:r>` +
    '<w:r><w:fldChar w:fldCharType="separate"/></w:r>' +
    `<w:r><w:t>${escapeXml(visible)}</w:t></w:r>` +
    '<w:r><w:fldChar w:fldCharType="end"/></w:r>'
  );
}

function cslField(json: Record<string, unknown>, visible: string): string {
  return `<w:p>${rawField(` ADDIN ZOTERO_ITEM CSL_CITATION ${JSON.stringify(json)} `, visible)}</w:p>`;
}

const baseCitation = (citationItems: unknown[], formattedCitation: string) => ({
  citationID: "abcd1234",
  properties: { formattedCitation },
  citationItems,
  schema: "https://github.com/citation-style-language/schema/raw/master/csl-citation.json",
});

describe("validatore docx (test/helpers/docx-validate.ts)", () => {
  it.each<CitationStyle>(["apa", "harvard", "chicago"])("DV-01 field code del prodotto, stile %s → valido, citeproc renderizza citazioni e bibliografia", async (style) => {
    const r = await expectValidDocx(await makeDocx(goodBody()), { style });
    expect(r.citations).toHaveLength(2);
    expect(r.bibliography).toEqual({ uncited: [], omitted: [], custom: [] });
    expect(r.rendered!.citations).toHaveLength(2);
    expect(r.rendered!.bibliography).toHaveLength(2);
    expect(r.rendered!.citations[1]).toMatch(/Doe/);
  });

  it.each<CitationStyle>(["ieee", "vancouver"])("DV-01b stile numerico %s: [1] e [1,2] coincidono con l'ordine di citeproc", async (style) => {
    const r = await expectValidDocx(await makeDocx(goodBody(["[1]", "[1,2]"])), { style });
    expect(r.rendered!.bibliography).toHaveLength(2);
  });

  it("DV-02 file non zip → errore", async () => {
    const r = await validateDocx(Buffer.from("not a zip"));
    expect(r.errors).toEqual([expect.stringMatching(/non è uno zip/)]);
  });

  it.each([
    ["[Content_Types].xml assente", "[Content_Types].xml", null, /parte mancante: \[Content_Types\]\.xml/],
    ["_rels/.rels assente", "_rels/.rels", null, /parte mancante: _rels\/\.rels/],
    ["parte senza content type", "word/media/image1.png", "x", /nessun content type per word\/media\/image1\.png/],
    [
      "Override di document.xml assente",
      "[Content_Types].xml",
      '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/></Types>',
      /content type di \/word\/document\.xml/,
    ],
    ["rels senza officeDocument", "_rels/.rels", '<?xml version="1.0"?><Relationships xmlns="x"/>', /officeDocument/],
    ["XML malformato in document.xml", "word/document.xml", "<w:document><w:body></w:document>", /XML non valido in word\/document\.xml/],
    [
      "Override verso una parte rimossa",
      "[Content_Types].xml",
      '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>',
      /content type per una parte inesistente: \/word\/styles\.xml/,
    ],
    [
      "relazione di document.xml verso una parte rimossa",
      "word/_rels/document.xml.rels",
      '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.org" TargetMode="External"/></Relationships>',
      /word\/_rels\/document\.xml\.rels: relazione verso una parte inesistente styles\.xml/,
    ],
  ])("DV-03 pacchetto: %s → errore", async (_label, name, content, message) => {
    const r = await validateDocx(await withPart(await makeDocx(goodBody()), name, content));
    expect(r.errors.join("\n")).toMatch(message);
  });

  it.each([
    ["end mancante", (b: string) => b.replace(/<w:r><w:fldChar w:fldCharType="end"\/><\/w:r><\/w:p>$/, "</w:p>"), /senza fldChar end/],
    ["separate senza begin", (b: string) => '<w:p><w:r><w:fldChar w:fldCharType="separate"/></w:r></w:p>' + b, /separate senza begin/],
    ["end senza begin", (b: string) => '<w:p><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>' + b, /end senza begin/],
    ["campo senza separate", (b: string) => b.replace('<w:r><w:fldChar w:fldCharType="separate"/></w:r>', ""), /campo senza separate/],
  ])("DV-04 campi sbilanciati: %s → errore", async (_label, mutate, message) => {
    const r = await validateDocx(await makeDocx(mutate(goodBody())));
    expect(r.errors.join("\n")).toMatch(message);
  });

  it("DV-05 JSON CSL_CITATION non valido → errore", async () => {
    const r = await validateDocx(await makeDocx(`<w:p>${rawField(" ADDIN ZOTERO_ITEM CSL_CITATION {broken ", "(Smith, 2023)")}</w:p>` + generateBibliographyFieldCode()));
    expect(r.errors.join("\n")).toMatch(/JSON CSL_CITATION non valido/);
  });

  it.each([
    ["campo sconosciuto in citationItem", { ...baseCitation([item(URI_A, SMITH, 0, { bogus: 1 })], "(Smith, 2023)") }, /schema csl-citation .*additional/],
    ["label fuori enum", { ...baseCitation([item(URI_A, SMITH, 0, { locator: "3", label: "pagina" })], "(Smith, 2023)") }, /schema csl-citation .*label/],
    ["itemData.type assente", { ...baseCitation([item(URI_A, { title: "x" })], "(Smith, 2023)") }, /schema csl-citation .*itemData/],
    ["schema URL sconosciuto", { ...baseCitation([item(URI_A, SMITH)], "(Smith, 2023)"), schema: "https://example.org/x.json" }, /schema csl-citation \/schema/],
    ["citationItems vuoto", { ...baseCitation([], "(Smith, 2023)") }, /citationItems vuoto/],
  ])("DV-06 schema: %s → errore", async (_label, json, message) => {
    const r = await validateDocx(await makeDocx(cslField(json, "(Smith, 2023)") + generateBibliographyFieldCode()));
    expect(r.errors.join("\n")).toMatch(message);
  });

  it("DV-06b deroghe documentate: uri legacy, formattedCitation e itemData senza id sono ammessi", async () => {
    const r = await validateDocx(await makeDocx(cslField(baseCitation([item(URI_A, SMITH)], "(Smith, 2023)"), "(Smith, 2023)") + generateBibliographyFieldCode()));
    expect(r.errors).toEqual([]);
  });

  it.each([
    ["chiave minuscola", "http://zotero.org/users/424242/items/smith001", /URI non valido/],
    ["host diverso", "https://zotero.org/users/424242/items/SMITH001", /URI non valido/],
    ["libreria diversa da quella attesa", "http://zotero.org/groups/777/items/SMITH001", /fuori dalla libreria attesa users\/424242/],
  ])("DV-07 URI: %s → errore", async (_label, uri, message) => {
    const body = `<w:p>${generateZoteroFieldCode([item(uri, SMITH)], "(Smith, 2023)")}</w:p>` + generateBibliographyFieldCode();
    const r = await validateDocx(await makeDocx(body), { libraryPath: "users/424242" });
    expect(r.errors.join("\n")).toMatch(message);
  });

  it("DV-08 formattedCitation diverso dal testo visibile → errore", async () => {
    const r = await validateDocx(await makeDocx(cslField(baseCitation([item(URI_A, SMITH)], "(Smith, 2023)"), "(Jones, 2023)") + generateBibliographyFieldCode()));
    expect(r.errors.join("\n")).toMatch(/formattedCitation "\(Smith, 2023\)" ≠ testo visibile "\(Jones, 2023\)"/);
  });

  it("DV-09 testo visibile con cognome o anno sbagliati → differenza rispetto a citeproc", async () => {
    const r = await validateDocx(await makeDocx(goodBody(["(Smyth, 2022)", "(Smith, 2023; Doe & Roe, 2019)"])));
    expect(r.errors).toEqual([]);
    expect(r.mismatches.join("\n")).toMatch(/cognome "Smith" assente dal testo visibile/);
    expect(r.mismatches.join("\n")).toMatch(/anno 2023 assente dal testo visibile/);
    await expect(expectValidDocx(await makeDocx(goodBody(["(Smyth, 2022)", "(Smith, 2023; Doe & Roe, 2019)"])))).rejects.toThrow(/Smith/);
  });

  it("DV-10 stile numerico con numerazione diversa dall'ordine di citazione → differenza", async () => {
    const r = await validateDocx(await makeDocx(goodBody(["[2]", "[1,2]"])), { style: "ieee" });
    expect(r.mismatches).toEqual([expect.stringMatching(/numeri 2 ≠ 1/)]);
  });

  it("DV-11 segnaposto <zcite> rimasto → errore, ammesso con allowLeftoverZcite", async () => {
    const body = goodBody() + '<w:p><w:r><w:t>&lt;zcite keys="X"/&gt;</w:t></w:r></w:p>';
    expect((await validateDocx(await makeDocx(body))).errors).toEqual(["segnaposto <zcite> rimasti nel documento"]);
    expect((await validateDocx(await makeDocx(body), { allowLeftoverZcite: true })).errors).toEqual([]);
  });

  it("DV-12 bibliografia assente o duplicata → errore", async () => {
    const noBib = goodBody().replace(generateBibliographyFieldCode(), "");
    expect((await validateDocx(await makeDocx(noBib))).errors).toContain("citazioni presenti ma nessun campo ZOTERO_BIBL");
    expect((await validateDocx(await makeDocx(noBib), { requireBibliography: false })).errors).toEqual([]);
    expect((await validateDocx(await makeDocx(goodBody() + generateBibliographyFieldCode()))).errors).toContain("più di un campo ZOTERO_BIBL");
  });

  it.each([
    ["[2,3]", [2, 3]],
    ["[1]–[3]", [1, 2, 3]],
    ["(1-3, 5)", [1, 2, 3, 5]],
    ["[?]", []],
  ])("DV-13 citationNumbers(%s)", (text, expected) => {
    expect(citationNumbers(text)).toEqual(expected);
  });

  it("DV-14 instrText spezzato su più run e campo annidato nel risultato: gestiti", async () => {
    const json = JSON.stringify(baseCitation([item(URI_A, SMITH)], "(Smith, 2023)"));
    const half = Math.floor(json.length / 2);
    const nested = rawField(" PAGE ", "");
    const body =
      '<w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r>' +
      `<w:r><w:instrText xml:space="preserve"> ADDIN ZOTERO_ITEM CSL_CITATION ${escapeXml(json.slice(0, half))}</w:instrText></w:r>` +
      `<w:r><w:instrText xml:space="preserve">${escapeXml(json.slice(half))} </w:instrText></w:r>` +
      `<w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>(Smith, </w:t></w:r>${nested}<w:r><w:t>2023)</w:t></w:r>` +
      '<w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>' +
      generateBibliographyFieldCode();
    const r = await expectValidDocx(await makeDocx(body));
    expect(r.citations[0].visible).toBe("(Smith, 2023)");
    expect(citations(documentXml(body))).toHaveLength(1);
  });

  it("DV-15 parità con Zotero: rileva plainCitation, itemData.id coerenti, label e ZOTERO_PREF", async () => {
    const zoteroLike = {
      ...baseCitation([item(URI_A, { ...SMITH, id: 101 }, 101, { locator: "12", label: "page" })], "(Smith, 2023, p. 12)"),
      properties: { formattedCitation: "(Smith, 2023, p. 12)", plainCitation: "(Smith, 2023, p. 12)", noteIndex: 0 },
    };
    let docx = await makeDocx(cslField(zoteroLike, "(Smith, 2023, p. 12)") + generateBibliographyFieldCode());
    docx = await withPart(docx, "docProps/custom.xml", '<?xml version="1.0"?><Properties><property name="ZOTERO_PREF_1"/></Properties>');
    const r = await expectValidDocx(docx);
    expect(r.parity).toEqual({ hasDocumentPrefs: true, allHavePlainCitation: true, allHaveNoteIndex: true, consistentItemIds: true, locatorsHaveLabel: true });

    const product = await validateDocx(await makeDocx(goodBody()));
    expect(product.parity).toEqual({ hasDocumentPrefs: false, allHavePlainCitation: false, allHaveNoteIndex: false, consistentItemIds: false, locatorsHaveLabel: true });
  });
});
