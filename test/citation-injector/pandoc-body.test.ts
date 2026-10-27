import { describe, it, expect } from "vitest";
import { parsePandocCitesInText, parsePandocCitesInBody, countPandocMarkers } from "../../src/citation-injector/pandoc-body.js";

/** PB-*: parser dei marcatori Pandoc. parsePandocCitesInText lavora su un singolo testo visibile. */
describe("parsePandocCitesInText (PB)", () => {
  it("PB-01 [@KEY] singolo (bracket, inline:false)", () => {
    const r = parsePandocCitesInText("As shown [@SMITH222] here.");
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ keys: ["SMITH222"], raw: "[@SMITH222]", inline: false });
  });

  it("PB-02 più voci [@A; @B]", () => {
    const [r] = parsePandocCitesInText("Both [@AAAA2222; @BBBB2222] cited.");
    expect(r.keys).toEqual(["AAAA2222", "BBBB2222"]);
    expect(r.raw).toBe("[@AAAA2222; @BBBB2222]");
  });

  it("PB-03 prefisso e locator [see @K, p. 12]", () => {
    const [r] = parsePandocCitesInText("x [see @SMITH222, p. 12] y");
    expect(r).toMatchObject({ keys: ["SMITH222"], prefix: "see", locator: "p. 12" });
  });

  it("PB-04 inline @KEY e soppressione autore -@KEY (inline:true)", () => {
    const r = parsePandocCitesInText("see @SMITH222 and -@SMITH222.");
    expect(r).toHaveLength(2);
    expect(r[0]).toMatchObject({ keys: ["SMITH222"], suppressAuthor: false, inline: true, raw: "@SMITH222" });
    expect(r[1]).toMatchObject({ keys: ["SMITH222"], suppressAuthor: true, inline: true, raw: "-@SMITH222" });
  });

  it("PB-05 una email non è una citazione", () => {
    expect(parsePandocCitesInText("write to john@example.com please")).toEqual([]);
  });

  it("PB-06 citekey con punteggiatura finale non inglobata", () => {
    const [r] = parsePandocCitesInText("per @rossi2020.");
    expect(r.keys).toEqual(["rossi2020"]);
    expect(r.raw).toBe("@rossi2020");
  });

  it("PB-07 entità XML nel prefisso deescapate; raw resta escapato", () => {
    const [r] = parsePandocCitesInText("x [see &amp; cf. @SMITH222] y");
    expect(r.prefix).toBe("see & cf.");
    expect(r.raw).toBe("[see &amp; cf. @SMITH222]");
  });

  it("PB-08 [@] senza chiave valida → nessuna richiesta", () => {
    expect(parsePandocCitesInText("empty [@] marker")).toEqual([]);
  });

  it("PB-09 inline preceduto da _ / . non è citazione (handle/percorso/codice)", () => {
    expect(parsePandocCitesInText("path/@user and a.@b and x_@y")).toEqual([]);
  });

  it("PB-10 handle/parola inline presa come citekey inline (la risoluzione la scarterà)", () => {
    const r = parsePandocCitesInText("hi @Component and @media here");
    expect(r.map((x) => ({ keys: x.keys, inline: x.inline }))).toEqual([
      { keys: ["Component"], inline: true },
      { keys: ["media"], inline: true },
    ]);
  });

  it("PB-11 @angular/core: inline si ferma a / (chiave 'angular')", () => {
    const [r] = parsePandocCitesInText("install @angular/core now");
    expect(r).toMatchObject({ keys: ["angular"], inline: true });
  });

  it("PB-12 bracket con URL: [see http://x.com/@user] non è una citazione (@ dopo /)", () => {
    expect(parsePandocCitesInText("x [see http://x.com/@user] y")).toEqual([]);
  });

  it("PB-13 bracket con citekey Better BibTeX [@rossi2020]", () => {
    const [r] = parsePandocCitesInText("see [@rossi2020]");
    expect(r).toMatchObject({ keys: ["rossi2020"], inline: false });
  });
});

describe("parsePandocCitesInBody (PB-B): solo testo visibile, mai field code/attributi", () => {
  it("PB-B01 docx: legge <w:t>, ignora <w:instrText>", () => {
    const body =
      '<w:p><w:r><w:t>See [@NEWK2222].</w:t></w:r>' +
      '<w:r><w:instrText> ADDIN ZOTERO_ITEM {"title":"Twitter: @handle"} </w:instrText></w:r></w:p>';
    const r = parsePandocCitesInBody(body, "docx");
    expect(r).toHaveLength(1);
    expect(r[0].keys).toEqual(["NEWK2222"]);
  });

  it("PB-B02 odt: legge il contenuto degli elementi, ignora il JSON CSL nell'attributo del reference mark", () => {
    const body =
      '<text:p>See [@NEWK2222].<text:reference-mark-start text:name="ZOTERO_ITEM CSL_CITATION {&quot;title&quot;:&quot;x @handle&quot;}"/></text:p>';
    const r = parsePandocCitesInBody(body, "odt");
    expect(r).toHaveLength(1);
    expect(r[0].keys).toEqual(["NEWK2222"]);
  });

  it("PB-B03 countPandocMarkers conta solo i marcatori nel testo visibile", () => {
    expect(countPandocMarkers("<w:p><w:r><w:t>none here</w:t></w:r></w:p>", "docx")).toBe(0);
    expect(countPandocMarkers("<w:p><w:r><w:t>[@A1B2C3D4] and @E5F6G7H8</w:t></w:r></w:p>", "docx")).toBe(2);
  });
});
