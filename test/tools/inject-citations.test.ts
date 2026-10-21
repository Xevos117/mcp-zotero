import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFile, mkdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { XMLValidator } from "fast-xml-parser";
import JSZip from "jszip";
import {
  Harness,
  startHarness,
  expectValidationError,
  expectErrorJson,
  expectToolError,
} from "../helpers/mcp-harness.js";
import { networkError } from "../helpers/fake-net.js";
import { ZBASE, zSingle, zError, article, USER_ID } from "../helpers/zotero-fake.js";
import { makeDocx, para, zcite, readDocumentXml, tempDir, TempDir } from "../helpers/fixtures.js";
import { citations, expectValidDocx, validateDocx, CitationStyle } from "../helpers/docx-validate.js";

const ITEM_ROUTE = new RegExp(`^${ZBASE.replace(/\./g, "\\.")}/items/[A-Z0-9]+$`);

/** Zotero: GET /items/KEY restituisce l'item dalla mappa (404 se assente). */
function serveItems(h: Harness, items: Record<string, Record<string, unknown>>) {
  h.net.on("GET", ITEM_ROUTE, (req) => {
    const key = req.url.pathname.split("/").pop()!;
    const item = items[key];
    return item ? zSingle({ key, ...item }) : zError(404, "Item not found");
  });
}

const SMITH = article("SMITH001", {
  title: "On Testing",
  creators: [{ creatorType: "author", firstName: "John", lastName: "Smith" }],
  date: "2023",
});
const DOE_ROE = article("DOEROE01", {
  title: "Pair Paper",
  creators: [
    { creatorType: "author", firstName: "Jane", lastName: "Doe" },
    { creatorType: "author", firstName: "Rick", lastName: "Roe" },
  ],
  date: "2019-03-01",
});

describe("inject_citations (MCP)", () => {
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

  it("IC-01 sostituisce <zcite> con field code Zotero, aggiunge bibliografia, scrive *_cited.docx", async () => {
    serveItems(h, { SMITH001: SMITH });
    const input = await dir.file("paper.docx", await makeDocx(para("As shown ", zcite({ keys: "SMITH001" }), " before.")));
    const original = await readFile(input);

    const out = await h.call("inject_citations", { file_path: input });

    expect(out.isError).toBe(false);
    expect(out.json).toEqual({ output_path: join(dir.path, "paper_cited.docx"), citations_found: 1, citations_injected: 1 });
    const xml = await readDocumentXml(await readFile(out.json.output_path));
    expect(XMLValidator.validate(xml)).toBe(true);
    expect(xml).not.toContain("zcite");
    expect(xml).toContain("ADDIN ZOTERO_ITEM CSL_CITATION");
    expect(xml).toContain("ADDIN ZOTERO_BIBL");
    expect(xml).toContain("(Smith, 2023)");
    expect(xml).toContain("As shown ");
    const [c] = citations(xml);
    expect(c.citationItems[0].uris).toEqual([`http://zotero.org/users/${USER_ID}/items/SMITH001`]);
    expect(c.citationItems[0].itemData).toMatchObject({ title: "On Testing" });
    await expectValidDocx(await readFile(out.json.output_path), { libraryPath: `users/${USER_ID}` });
    // l'originale non viene toccato
    expect((await readFile(input)).equals(original)).toBe(true);
    expect(h.net.requests("GET", ITEM_ROUTE).map((r) => r.url.pathname)).toEqual([`/users/${USER_ID}/items/SMITH001`]);
  });

  it("IC-02 più tag, multi-chiave e chiavi ripetute: una sola GET per chiave", async () => {
    serveItems(h, { SMITH001: SMITH, DOEROE01: DOE_ROE });
    const input = await dir.file(
      "multi.docx",
      await makeDocx(
        para("A ", zcite({ keys: "SMITH001" })) +
          para("B ", zcite({ keys: "SMITH001,DOEROE01" })) +
          para("C ", zcite({ keys: "DOEROE01" }))
      )
    );
    const out = await h.call("inject_citations", { file_path: input });
    expect(out.json).toMatchObject({ citations_found: 3, citations_injected: 3 });
    const xml = await readDocumentXml(await readFile(out.json.output_path));
    expect(xml).toContain("(Smith, 2023; Doe &amp; Roe, 2019)");
    expect(citations(xml)).toHaveLength(3);
    expect(h.net.requests("GET", ITEM_ROUTE)).toHaveLength(2);
    await expectValidDocx(await readFile(out.json.output_path));
  });

  it('IC-22 keys="A, B" con spazi: chiavi ripulite, nessuna GET con spazio nel path', async () => {
    serveItems(h, { SMITH001: SMITH, DOEROE01: DOE_ROE });
    const input = await dir.file("spaces.docx", await makeDocx(para("S ", zcite({ keys: " SMITH001, DOEROE01 ," }))));
    const out = await h.call("inject_citations", { file_path: input });
    expect(out.isError).toBe(false);
    expect(out.json).toMatchObject({ citations_found: 1, citations_injected: 1 });
    const [c] = citations(await readDocumentXml(await readFile(out.json.output_path)));
    expect(c.citationItems.map((ci: { uris: string[] }) => ci.uris[0])).toEqual([
      `http://zotero.org/users/${USER_ID}/items/SMITH001`,
      `http://zotero.org/users/${USER_ID}/items/DOEROE01`,
    ]);
    expect(h.net.unmatched).toEqual([]);
  });

  it("IC-23 itemData: volume/issue/page/publisher inclusi, abstract escluso (field code leggero)", async () => {
    serveItems(h, {
      FULL0001: article("FULL0001", {
        title: "Full Record",
        creators: [{ creatorType: "author", firstName: "Hans", lastName: "de Kroon" }],
        date: "2017-10-18",
        volume: "12",
        issue: "10",
        pages: "e0185809",
        publisher: "PLOS",
        place: "San Francisco",
        abstractNote: "A long abstract that must not end up in the field code.",
      }),
    });
    const input = await dir.file("full.docx", await makeDocx(para(zcite({ keys: "FULL0001" }))));
    const out = await h.call("inject_citations", { file_path: input });
    const [c] = citations(await readDocumentXml(await readFile(out.json.output_path)));
    expect(c.citationItems[0].itemData).toMatchObject({
      volume: "12",
      issue: "10",
      page: "e0185809",
      publisher: "PLOS",
      "publisher-place": "San Francisco",
      author: [{ family: "de Kroon", given: "Hans" }],
    });
    expect(c.citationItems[0].itemData).not.toHaveProperty("abstract");
    await expectValidDocx(await readFile(out.json.output_path));
  });

  it("IC-03 attributi locator/prefix/suffix nel field code", async () => {
    serveItems(h, { SMITH001: SMITH });
    const input = await dir.file(
      "attrs.docx",
      await makeDocx(para(zcite({ keys: "SMITH001", locator: "pp. 12-15", prefix: "see ", suffix: ", emphasis added" })))
    );
    const out = await h.call("inject_citations", { file_path: input });
    const [c] = citations(await readDocumentXml(await readFile(out.json.output_path)));
    expect(c.citationItems[0]).toMatchObject({ locator: "pp. 12-15", prefix: "see ", suffix: ", emphasis added" });
    await expectValidDocx(await readFile(out.json.output_path));
  });

  it("IC-04 stile ieee con num → [n]; senza num → [?] e warning", async () => {
    serveItems(h, { SMITH001: SMITH, DOEROE01: DOE_ROE });
    const input = await dir.file(
      "ieee.docx",
      await makeDocx(para(zcite({ keys: "SMITH001", num: "1" })) + para(zcite({ keys: "DOEROE01" })))
    );
    const out = await h.call("inject_citations", { file_path: input, style: "ieee" });
    expect(out.json.warnings).toEqual([expect.stringContaining("1/2")]);
    const xml = await readDocumentXml(await readFile(out.json.output_path));
    expect(xml).toContain("[1]");
    expect(xml).toContain("[?]");
    // struttura valida; "[?]" non corrisponde al numero che Zotero scriverà al Refresh
    const report = await expectValidDocx(await readFile(out.json.output_path), { style: "ieee", allowMismatches: true });
    expect(report.mismatches).toEqual([expect.stringContaining('"[?]"')]);
  });

  it("IC-05 vancouver con tutti i num → nessun warning", async () => {
    serveItems(h, { SMITH001: SMITH });
    const input = await dir.file("v.docx", await makeDocx(para(zcite({ keys: "SMITH001", num: "1" }))));
    const out = await h.call("inject_citations", { file_path: input, style: "vancouver" });
    expect(out.json).not.toHaveProperty("warnings");
  });

  it("IC-06 nessun zcite → found 0, output scritto, nessuna chiamata Zotero", async () => {
    const input = await dir.file("plain.docx", await makeDocx(para("No citations here.")));
    const out = await h.call("inject_citations", { file_path: input });
    expect(out.json).toEqual({ output_path: join(dir.path, "plain_cited.docx"), citations_found: 0, citations_injected: 0 });
    await expect(stat(out.json.output_path)).resolves.toBeTruthy();
    expect(h.net.calls).toHaveLength(0);
  });

  it("IC-07 unicode in autori/titoli: testo visibile ed XML ben formato", async () => {
    serveItems(h, {
      UNI00001: article("UNI00001", {
        title: "Über «Lernen» & 学习",
        creators: [{ creatorType: "author", firstName: "Jürgen", lastName: "Müller-Ødegård" }],
        date: "2021",
      }),
      NOAUTH01: article("NOAUTH01", { title: "机器学习的一个非常非常长的标题，超过三十个字符的那种标题文本再加上十个字符的内容", creators: [], date: "" }),
    });
    const input = await dir.file("ünï.docx", await makeDocx(para("Testo ", zcite({ keys: "UNI00001" }), " e ", zcite({ keys: "NOAUTH01" }))));
    const out = await h.call("inject_citations", { file_path: input });
    expect(out.json.output_path).toBe(join(dir.path, "ünï_cited.docx"));
    const xml = await readDocumentXml(await readFile(out.json.output_path));
    expect(XMLValidator.validate(xml)).toBe(true);
    expect(xml).toContain("(Müller-Ødegård, 2021)");
    expect(xml).toMatch(/\(&quot;机器学习.{0,40}\.\.\.&quot;, n\.d\.\)/);
    expect(citations(xml)[0].citationItems[0].itemData.title).toBe("Über «Lernen» & 学习");
    await expectValidDocx(await readFile(out.json.output_path));
  });

  it("IC-08 file non .docx → errore strutturato senza rete", async () => {
    const json = expectErrorJson(await h.call("inject_citations", { file_path: "/tmp/document.pdf" }), "File must be a .docx file");
    expect(json.file_path).toBe("/tmp/document.pdf");
    expect(h.net.calls).toHaveLength(0);
  });

  it("IC-09 estensione maiuscola .DOCX → rifiutata (controllo case-sensitive)", async () => {
    expectErrorJson(await h.call("inject_citations", { file_path: "/tmp/PAPER.DOCX" }), "File must be a .docx file");
  });

  it("IC-10 file inesistente → isError che indica la skill e dove scaricarla", async () => {
    const json = expectErrorJson(await h.call("inject_citations", { file_path: join(dir.path, "missing.docx") }), "File not found");
    expect(json.error).toContain("zotero-mcp-integrations");
    expect(json.error).toContain("https://github.com/Xevos117/mcp-zotero/releases/latest");
    expect(json.file_path).toBe(join(dir.path, "missing.docx"));
    expect(json.hint).toBeUndefined();
  });

  it("IC-10b percorso relativo inesistente → stesso errore più il suggerimento del percorso assoluto", async () => {
    const json = expectErrorJson(await h.call("inject_citations", { file_path: "outputs/paper.docx" }), "File not found");
    expect(json.hint).toBe("Pass an absolute path.");
  });

  describe(".docx malformati", () => {
    it("IC-11 byte casuali (non zip) → isError", async () => {
      const input = await dir.file("random.docx", Buffer.from("this is definitely not a zip file"));
      expectToolError(await h.call("inject_citations", { file_path: input }));
    });

    it("IC-12 zip valido senza word/document.xml → isError che cita document.xml", async () => {
      const input = await dir.file("nodoc.docx", await makeDocx("", { omitDocument: true }));
      expectToolError(await h.call("inject_citations", { file_path: input }), "word/document.xml");
    });

    it("IC-13 zip troncato → isError", async () => {
      const full = await makeDocx(para(zcite({ keys: "SMITH001" })));
      const input = await dir.file("truncated.docx", full.subarray(0, Math.floor(full.length / 2)));
      expectToolError(await h.call("inject_citations", { file_path: input }));
    });

    it("IC-14 file vuoto → isError", async () => {
      const input = await dir.file("empty.docx", Buffer.alloc(0));
      expectToolError(await h.call("inject_citations", { file_path: input }));
    });

    it("IC-15 zcite senza attributo keys viene ignorato", async () => {
      const input = await dir.file("nokeys.docx", await makeDocx(para(zcite({ num: "1" }))));
      const out = await h.call("inject_citations", { file_path: input });
      expect(out.json.citations_found).toBe(0);
      expect(h.net.calls).toHaveLength(0);
    });
  });

  describe("errori Zotero", () => {
    it("IC-16 chiavi inesistenti (404) → isError che le elenca tutte, come inject.js; nessun output scritto", async () => {
      serveItems(h, { SMITH001: SMITH });
      const input = await dir.file("missingkey.docx", await makeDocx(para(zcite({ keys: "NOPE2222" })) + para(zcite({ keys: "SMITH001,NOPE3333" }))));
      const out = await h.call("inject_citations", { file_path: input });
      expectToolError(out, "2 cited key(s) not found in the library: NOPE2222, NOPE3333");
      expect(out.text).not.toMatch(/\b404\b/);
      await expect(stat(join(dir.path, "missingkey_cited.docx"))).rejects.toThrow();
    });

    it.each(["../tags", "AB?C", "SMITH001,../items/X"])(
      'IC-24 chiave <zcite> non alfanumerica "%s" → isError, nessuna richiesta, nessun output',
      async (keys) => {
        const input = await dir.file("badkey.docx", await makeDocx(para(zcite({ keys }))));
        expectToolError(await h.call("inject_citations", { file_path: input }), "Invalid Zotero item key(s) in <zcite>");
        expect(h.net.calls).toHaveLength(0);
        await expect(stat(join(dir.path, "badkey_cited.docx"))).rejects.toThrow();
      }
    );

    it.each([403, 429, 500, 503])("IC-17 HTTP %i → isError", async (status) => {
      h.net.on("GET", ITEM_ROUTE, zError(status));
      const input = await dir.file(`e${status}.docx`, await makeDocx(para(zcite({ keys: "SMITH001" }))));
      expectToolError(await h.call("inject_citations", { file_path: input }), String(status));
    });

    it("IC-18 errore di rete → isError", async () => {
      h.net.on("GET", ITEM_ROUTE, networkError());
      const input = await dir.file("net.docx", await makeDocx(para(zcite({ keys: "SMITH001" }))));
      expectToolError(await h.call("inject_citations", { file_path: input }));
    });
  });

  it("IC-19 il .docx di output resta uno zip valido con le altre parti intatte", async () => {
    serveItems(h, { SMITH001: SMITH });
    const input = await dir.file("parts.docx", await makeDocx(para(zcite({ keys: "SMITH001" }))));
    const out = await h.call("inject_citations", { file_path: input });
    const zip = await JSZip.loadAsync(await readFile(out.json.output_path));
    expect(zip.file("word/document.xml")).not.toBeNull();
    expect(zip.file("[Content_Types].xml")).not.toBeNull();
    expect(zip.file("_rels/.rels")).not.toBeNull();
    await expectValidDocx(await readFile(out.json.output_path));
  });

  // BUG: injector.ts:162/208 usa filePath.replace(".docx", "_cited.docx"), che
  // sostituisce la PRIMA occorrenza: con una cartella che contiene ".docx" nel
  // nome l'output finisce in un percorso sbagliato (o la scrittura fallisce).
  it("IC-20 cartella con '.docx' nel nome: output accanto all'input", async () => {
    serveItems(h, { SMITH001: SMITH });
    const sub = join(dir.path, "thesis.docx.d");
    await mkdir(sub);
    const input = join(sub, "paper.docx");
    await (await import("node:fs/promises")).writeFile(input, await makeDocx(para(zcite({ keys: "SMITH001" }))));
    const out = await h.call("inject_citations", { file_path: input });
    expect(out.isError).toBe(false);
    expect(out.json.output_path).toBe(join(sub, "paper_cited.docx"));
  });

  describe("validazione input", () => {
    it.each([
      ["file_path", {}],
      ["file_path", { file_path: 1 }],
      ["style", { file_path: "/tmp/a.docx", style: "mla" }],
    ])("IC-21 rifiuta %s non valido (%j)", async (field, args) => {
      expectValidationError(await h.call("inject_citations", args), field);
      expect(h.net.calls).toHaveLength(0);
    });
  });

  // Validazione strutturale + rendering citeproc con gli stili CSL veri (test/helpers/docx-validate.ts)
  describe("validazione docx (IC-V)", () => {
    const LIBRARY: Record<string, Record<string, unknown>> = {
      SMITH001: SMITH,
      DOEROE01: DOE_ROE,
      MANY0001: article("MANY0001", {
        title: "Many Authors",
        date: "2020-06-25",
        creators: ["Pessoa", "Sadykov", "Uchoa", "Vanderbeck"].map((lastName) => ({ creatorType: "author", firstName: "A.", lastName })),
      }),
      KROON001: article("KROON001", {
        title: "Insects",
        date: "2017-10-18",
        creators: [
          { creatorType: "author", firstName: "Caspar A.", lastName: "Hallmann" },
          { creatorType: "author", firstName: "Hans", lastName: "de Kroon" },
        ],
      }),
      UNI00001: article("UNI00001", { title: "Über «Lernen» & 学习", date: "2021", creators: [{ creatorType: "author", firstName: "Jürgen", lastName: "Müller-Ødegård" }] }),
      NOAUTH01: article("NOAUTH01", { title: "Anonymous memo", date: "2019", creators: [] }),
      CONSORT1: { itemType: "report", title: "Consortium report", date: "2021", creators: [{ creatorType: "author", name: "Test Consortium" }] },
    };
    // num coerenti con l'ordine di prima citazione, come li numera citeproc
    const BODY = (numbered: boolean) =>
      para("Single ", zcite({ keys: "SMITH001", ...(numbered && { num: "1" }) })) +
      para("Pair and many ", zcite({ keys: "DOEROE01,MANY0001", ...(numbered && { num: "2,3" }) })) +
      para("Locator ", zcite({ keys: "KROON001", locator: "pp. 12-15", prefix: "see ", suffix: ", fig. 2", ...(numbered && { num: "4" }) })) +
      para("Unicode, no author, institution ", zcite({ keys: "UNI00001,NOAUTH01,CONSORT1", ...(numbered && { num: "5-7" }) })) +
      para("Repeated ", zcite({ keys: "SMITH001", ...(numbered && { num: "1" }) }));

    it.each<CitationStyle>(["apa", "harvard", "chicago", "ieee", "vancouver"])(
      "IC-V01 stile %s: struttura, schema CSL, URI, citeproc (citazioni + bibliografia) e parti chiave del testo visibile",
      async (style) => {
        serveItems(h, LIBRARY);
        const numbered = style === "ieee" || style === "vancouver";
        const input = await dir.file(`matrix-${style}.docx`, await makeDocx(BODY(numbered)));
        const out = await h.call("inject_citations", { file_path: input, style });
        expect(out.isError).toBe(false);
        expect(out.json).toMatchObject({ citations_found: 5, citations_injected: 5 });
        const r = await expectValidDocx(await readFile(out.json.output_path), { style, libraryPath: `users/${USER_ID}` });
        expect(r.citations).toHaveLength(5);
        expect(r.rendered!.bibliography).toHaveLength(7);
      }
    );

    it("IC-V02 libreria di gruppo per chiamata → URI /groups/<id>/ validi", async () => {
      h.net.on("GET", /^api\.zotero\.org\/groups\/777\/items\/[A-Z0-9]+$/, (req) => {
        const key = req.url.pathname.split("/").pop()!;
        return zSingle({ key, ...LIBRARY[key] });
      });
      const input = await dir.file("group.docx", await makeDocx(para(zcite({ keys: "SMITH001,DOEROE01" }))));
      const out = await h.call("inject_citations", { file_path: input, library_type: "group", library_id: "777" });
      expect(out.isError).toBe(false);
      await expectValidDocx(await readFile(out.json.output_path), { libraryPath: "groups/777" });
    });

    /**
     * Ipotesi su Word (test/WORD_CHECKLIST.md, H-W1..H-W5): differenze rispetto ai campi che scrive Zotero
     * for Word. Non è dimostrato che diano problemi in Word: sono it.fails finché la checklist manuale non
     * le conferma (allora si corregge il prodotto e il caso diventa un test normale) o le smentisce
     * (allora il caso si rimuove). inject.js produce lo stesso JSON, quindi valgono anche per la skill.
     */
    describe("ipotesi Word (it.fails finché la checklist non decide)", () => {
      async function productReport() {
        serveItems(h, LIBRARY);
        const input = await dir.file("hyp.docx", await makeDocx(BODY(false)));
        const out = await h.call("inject_citations", { file_path: input });
        return validateDocx(await readFile(out.json.output_path));
      }

      it.fails("IC-V-H1 docProps/custom.xml con le preferenze ZOTERO_PREF_* (H-W1)", async () => {
        expect((await productReport()).parity.hasDocumentPrefs).toBe(true);
      });
      it.fails("IC-V-H2 properties.plainCitation presente in ogni citazione (H-W2)", async () => {
        expect((await productReport()).parity.allHavePlainCitation).toBe(true);
      });
      it.fails("IC-V-H2b properties.noteIndex presente in ogni citazione (H-W2)", async () => {
        expect((await productReport()).parity.allHaveNoteIndex).toBe(true);
      });
      it.fails("IC-V-H3 itemData.id presente e citationItems[].id coerenti per URI in tutto il documento (H-W3)", async () => {
        expect((await productReport()).parity.consistentItemIds).toBe(true);
      });
      it.fails("IC-V-H4 locator accompagnato da label (H-W4)", async () => {
        expect((await productReport()).parity.locatorsHaveLabel).toBe(true);
      });
      it.todo("IC-V-H5 voci di un gruppo non sincronizzato nel client Zotero locale (H-W5): verificabile solo in Word");
    });
  });
});
