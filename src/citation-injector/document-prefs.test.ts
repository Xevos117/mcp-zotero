import { describe, it, expect } from "vitest";
import JSZip from "jszip";
import { PREF_CHUNK, ZOTERO_STYLE_IDS, prefChunks, writeZoteroDocumentPrefs, zoteroDocumentData } from "./document-prefs.js";

const TYPES =
  '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>';
const RELS =
  '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>';

function docx(custom?: string): JSZip {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", TYPES);
  zip.file("_rels/.rels", RELS);
  zip.file("word/document.xml", "<w:document/>");
  if (custom !== undefined) zip.file("docProps/custom.xml", custom);
  return zip;
}
const part = (zip: JSZip, name: string) => zip.file(name)!.async("string");

describe("document-prefs (preferenze Zotero del documento, H-W1)", () => {
  it("DP-01 valore come lo serializza Zotero: data-version 3, sessione di 8 caratteri, stile, fieldType Field", () => {
    const v = zoteroDocumentData("http://www.zotero.org/styles/apa", "Field", "AbCd1234");
    expect(v).toBe(
      '<data data-version="3"><session id="AbCd1234"/><style id="http://www.zotero.org/styles/apa" locale="en-US" hasBibliography="1" bibliographyStyleHasBeenSet="0"/><prefs><pref name="fieldType" value="Field"/></prefs></data>'
    );
    // fieldType ReferenceMark per LibreOffice (default Field per Word)
    expect(zoteroDocumentData("x", "ReferenceMark", "S")).toContain('<pref name="fieldType" value="ReferenceMark"/>');
    expect(zoteroDocumentData("x")).toMatch(/<session id="[A-Za-z0-9]{8}"\/>/);
    expect(zoteroDocumentData("x")).toContain('<pref name="fieldType" value="Field"/>');
    expect(Object.keys(ZOTERO_STYLE_IDS)).toEqual(["apa", "ieee", "vancouver", "harvard", "chicago"]);
  });

  it("DP-02 valore spezzato in parti di al massimo 255 caratteri, ricomponibili", () => {
    const long = "x".repeat(PREF_CHUNK * 2 + 10);
    const chunks = prefChunks(long);
    expect(chunks.map((c) => c.length)).toEqual([255, 255, 10]);
    expect(chunks.join("")).toBe(long);
  });

  it("DP-03 documento senza proprietà: custom.xml, Override e relazione aggiunti", async () => {
    const zip = docx();
    expect(await writeZoteroDocumentPrefs(zip, "ieee")).toBe("written");
    const custom = await part(zip, "docProps/custom.xml");
    expect(custom).toContain('pid="2" name="ZOTERO_PREF_1"');
    expect(custom).toContain("&lt;style id=&quot;http://www.zotero.org/styles/ieee&quot;");
    expect(await part(zip, "[Content_Types].xml")).toContain('<Override PartName="/docProps/custom.xml" ContentType="application/vnd.openxmlformats-officedocument.custom-properties+xml"/>');
    expect(await part(zip, "_rels/.rels")).toContain('<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/custom-properties" Target="docProps/custom.xml"/>');
  });

  it("DP-04 custom.xml esistente senza Zotero: proprietà conservate, pid successivi, Override e relazione non duplicati", async () => {
    const own = '<property fmtid="{D5CDD505-2E9C-101B-9397-08002B2CF9AE}" pid="5" name="Project"><vt:lpwstr>Thesis</vt:lpwstr></property>';
    const zip = docx(`<?xml version="1.0"?><Properties xmlns="p" xmlns:vt="v">${own}</Properties>`);
    zip.file("[Content_Types].xml", TYPES.replace("</Types>", '<Override PartName="/docProps/custom.xml" ContentType="application/vnd.openxmlformats-officedocument.custom-properties+xml"/></Types>'));
    zip.file("_rels/.rels", RELS.replace("</Relationships>", '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/custom-properties" Target="docProps/custom.xml"/></Relationships>'));
    expect(await writeZoteroDocumentPrefs(zip, "apa")).toBe("written");
    const custom = await part(zip, "docProps/custom.xml");
    expect(custom).toContain(own);
    expect(custom).toContain('pid="6" name="ZOTERO_PREF_1"');
    expect((await part(zip, "[Content_Types].xml")).match(/custom-properties\+xml/g)).toHaveLength(1);
    expect((await part(zip, "_rels/.rels")).match(/relationships\/custom-properties/g)).toHaveLength(1);
  });

  it("DP-05 documento già gestito da Zotero (ZOTERO_PREF_*) o stile sconosciuto → nulla cambia", async () => {
    const managed = '<?xml version="1.0"?><Properties><property pid="2" name="ZOTERO_PREF_1"><vt:lpwstr>x</vt:lpwstr></property></Properties>';
    const zip = docx(managed);
    expect(await writeZoteroDocumentPrefs(zip, "apa")).toBe("kept");
    expect(await part(zip, "docProps/custom.xml")).toBe(managed);
    expect(await part(zip, "[Content_Types].xml")).toBe(TYPES);
    const plain = docx();
    expect(await writeZoteroDocumentPrefs(plain, "mla")).toBe("skipped");
    expect(plain.file("docProps/custom.xml")).toBeNull();
  });

  it("DP-06 custom.xml vuoto e senza prefisso vt: proprietà inserite e prefisso dichiarato", async () => {
    const zip = docx('<?xml version="1.0"?><Properties xmlns="p"/>');
    expect(await writeZoteroDocumentPrefs(zip, "chicago")).toBe("written");
    const custom = await part(zip, "docProps/custom.xml");
    expect(custom).toMatch(/^<\?xml version="1.0"\?><Properties xmlns:vt="http:\/\/schemas\.openxmlformats\.org\/officeDocument\/2006\/docPropsVTypes" xmlns="p"><property [^>]*name="ZOTERO_PREF_1">/);
    expect(custom).toContain("chicago-author-date");
  });

  const NS = "http://schemas.openxmlformats.org/officeDocument/2006/custom-properties";
  const VT = "http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes";
  const own = (p = "") => `<${p}property fmtid="{D5CDD505-2E9C-101B-9397-08002B2CF9AE}" pid="2" name="Client"><vt:lpwstr>ACME</vt:lpwstr></${p}property>`;

  it("DP-07 radice con prefisso (<op:Properties>): proprietà unite con lo stesso prefisso, quelle dell'utente conservate", async () => {
    const zip = docx(`<?xml version="1.0"?><op:Properties xmlns:op="${NS}" xmlns:vt="${VT}">${own("op:")}</op:Properties>`);
    expect(await writeZoteroDocumentPrefs(zip, "apa")).toBe("written");
    const custom = await part(zip, "docProps/custom.xml");
    expect(custom).toContain(own("op:"));
    expect(custom).toMatch(/<op:property [^>]*pid="3" name="ZOTERO_PREF_1"><vt:lpwstr>[^<]+<\/vt:lpwstr><\/op:property><\/op:Properties>$/);
  });

  it("DP-08 testo dopo la radice (commento): inserite prima dell'ultima </Properties>, nulla perso", async () => {
    const zip = docx(`<?xml version="1.0"?><Properties xmlns="${NS}" xmlns:vt="${VT}">${own()}</Properties><!-- x -->`);
    expect(await writeZoteroDocumentPrefs(zip, "apa")).toBe("written");
    const custom = await part(zip, "docProps/custom.xml");
    expect(custom).toContain(own());
    expect(custom).toMatch(/name="ZOTERO_PREF_1">.*<\/property><\/Properties><!-- x -->$/);
  });

  it("DP-09 preferenze esistenti con apici singoli → kept, nulla cambia", async () => {
    const existing = `<?xml version="1.0"?><Properties xmlns="${NS}" xmlns:vt="${VT}"><property pid='2' name='ZOTERO_PREF_1'><vt:lpwstr>x</vt:lpwstr></property></Properties>`;
    const zip = docx(existing);
    expect(await writeZoteroDocumentPrefs(zip, "apa")).toBe("kept");
    expect(await part(zip, "docProps/custom.xml")).toBe(existing);
  });

  it("DP-10 parte delle proprietà indicata dalla relazione (docProps/custom2.xml): letta e unita lì, nessuna parte né relazione nuova", async () => {
    const zip = docx();
    zip.file("_rels/.rels", RELS.replace("</Relationships>", '<Relationship Id="rId9" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/custom-properties" Target="/docProps/custom2.xml"/></Relationships>'));
    zip.file("docProps/custom2.xml", `<?xml version="1.0"?><Properties xmlns="${NS}" xmlns:vt="${VT}"><property pid="2" name="ZOTERO_PREF_1"><vt:lpwstr>x</vt:lpwstr></property></Properties>`);
    expect(await writeZoteroDocumentPrefs(zip, "apa")).toBe("kept");
    expect(zip.file("docProps/custom.xml")).toBeNull();
    zip.file("docProps/custom2.xml", `<?xml version="1.0"?><Properties xmlns="${NS}" xmlns:vt="${VT}">${own()}</Properties>`);
    expect(await writeZoteroDocumentPrefs(zip, "ieee")).toBe("written");
    expect(await part(zip, "docProps/custom2.xml")).toContain('name="ZOTERO_PREF_1"');
    expect(zip.file("docProps/custom.xml")).toBeNull();
    expect((await part(zip, "_rels/.rels")).match(/relationships\/custom-properties/g)).toHaveLength(1);
    expect(await part(zip, "[Content_Types].xml")).toContain('PartName="/docProps/custom2.xml"');
  });

  it("DP-11 parte esistente senza radice Properties riconoscibile → skipped, mai riscritta, nessun Override né relazione", async () => {
    const odd = '<?xml version="1.0"?><x:Other xmlns:x="y"/>';
    const zip = docx(odd);
    expect(await writeZoteroDocumentPrefs(zip, "apa")).toBe("skipped");
    expect(await part(zip, "docProps/custom.xml")).toBe(odd);
    expect(await part(zip, "[Content_Types].xml")).toBe(TYPES);
    expect(await part(zip, "_rels/.rels")).toBe(RELS);
  });
});
