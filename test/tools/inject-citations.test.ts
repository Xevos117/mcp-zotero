import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFile, mkdir, stat, writeFile, chmod } from "node:fs/promises";
import { join } from "node:path";
import { XMLValidator } from "fast-xml-parser";
import JSZip from "jszip";
import {
  Harness,
  startHarness,
  expectValidationError,
  expectErrorJson,
  expectToolError,
  expectApiError,
} from "../helpers/mcp-harness.js";
import { networkError } from "../helpers/fake-net.js";
import { ZBASE, zSingle, zError, article, USER_ID } from "../helpers/zotero-fake.js";
import { makeDocx, para, zcite, readDocumentXml, tempDir, TempDir } from "../helpers/fixtures.js";
import { citations, expectValidDocx, validateDocx, styleId, CitationStyle } from "../helpers/docx-validate.js";

const ITEM_ROUTE = new RegExp(`^${ZBASE.replace(/\./g, "\\.")}/items/[A-Z0-9]+$`);

/** Zotero: GET /items/KEY restituisce l'item dalla mappa (404 se assente). */
function serveItems(h: Harness, items: Record<string, Record<string, unknown>>) {
  h.net.on("GET", ITEM_ROUTE, (req) => {
    const key = req.url.pathname.split("/").pop()!;
    const item = items[key];
    return item ? zSingle({ key, ...item }) : zError(404, "Item not found");
  });
}

const SMITH = article("SMITH222", {
  title: "On Testing",
  creators: [{ creatorType: "author", firstName: "John", lastName: "Smith" }],
  date: "2023",
});
const DOE_ROE = article("PAIR2222", {
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
    serveItems(h, { SMITH222: SMITH });
    const input = await dir.file("paper.docx", await makeDocx(para("As shown ", zcite({ keys: "SMITH222" }), " before.")));
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
    expect(c.citationItems[0].uris).toEqual([`http://zotero.org/users/${USER_ID}/items/SMITH222`]);
    expect(c.citationItems[0].itemData).toMatchObject({ title: "On Testing" });
    await expectValidDocx(await readFile(out.json.output_path), { libraryPath: `users/${USER_ID}` });
    // l'originale non viene toccato
    expect((await readFile(input)).equals(original)).toBe(true);
    expect(h.net.requests("GET", ITEM_ROUTE).map((r) => r.url.pathname)).toEqual([`/users/${USER_ID}/items/SMITH222`]);
  });

  it("IC-01b metadati con caratteri XML/HTML (titolo con <script>, &, ]]>) → testo letterale, docx valido", async () => {
    const HOSTILE = article("HQST2345", {
      title: "<script>alert(1)</script> & ]]> \"quoted\" <w:r><w:t>x</w:t></w:r>",
      publicationTitle: "Computers & Operations Research",
      creators: [{ creatorType: "author", firstName: "Ángel", lastName: "Felipe & <Co>" }],
      date: "2009",
    });
    serveItems(h, { HQST2345: HOSTILE });
    const input = await dir.file("hostile.docx", await makeDocx(para("See ", zcite({ keys: "HQST2345" }), ".")));
    const out = await h.call("inject_citations", { file_path: input });
    expect(out.isError, out.text).toBe(false);
    const bytes = await readFile(out.json.output_path);
    const xml = await readDocumentXml(bytes);
    expect(XMLValidator.validate(xml)).toBe(true);
    // nessun elemento iniettato: i caratteri speciali arrivano escapati nel documento
    expect(xml).not.toContain("<script>");
    expect(xml).not.toMatch(/<w:t>x<\/w:t><\/w:r>/);
    const [c] = citations(xml);
    expect(c.citationItems[0].itemData).toMatchObject({
      title: "<script>alert(1)</script> & ]]> \"quoted\" <w:r><w:t>x</w:t></w:r>",
      "container-title": "Computers & Operations Research",
    });
    await expectValidDocx(bytes, { libraryPath: `users/${USER_ID}` });
  });

  it("IC-02 più tag, multi-chiave e chiavi ripetute: una sola GET per chiave", async () => {
    serveItems(h, { SMITH222: SMITH, PAIR2222: DOE_ROE });
    const input = await dir.file(
      "multi.docx",
      await makeDocx(
        para("A ", zcite({ keys: "SMITH222" })) +
          para("B ", zcite({ keys: "SMITH222,PAIR2222" })) +
          para("C ", zcite({ keys: "PAIR2222" }))
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
    serveItems(h, { SMITH222: SMITH, PAIR2222: DOE_ROE });
    const input = await dir.file("spaces.docx", await makeDocx(para("S ", zcite({ keys: " SMITH222, PAIR2222 ," }))));
    const out = await h.call("inject_citations", { file_path: input });
    expect(out.isError).toBe(false);
    expect(out.json).toMatchObject({ citations_found: 1, citations_injected: 1 });
    const [c] = citations(await readDocumentXml(await readFile(out.json.output_path)));
    expect(c.citationItems.map((ci: { uris: string[] }) => ci.uris[0])).toEqual([
      `http://zotero.org/users/${USER_ID}/items/SMITH222`,
      `http://zotero.org/users/${USER_ID}/items/PAIR2222`,
    ]);
    expect(h.net.unmatched).toEqual([]);
  });

  it("IC-23 itemData: volume/issue/page/publisher inclusi, abstract escluso (field code leggero)", async () => {
    serveItems(h, {
      FULL2222: article("FULL2222", {
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
    const input = await dir.file("full.docx", await makeDocx(para(zcite({ keys: "FULL2222" }))));
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

  it("IC-23b capitolo di libro: itemData con titolo del libro, curatori e autore istituzionale (literal); bibliografia citeproc completa", async () => {
    serveItems(h, {
      CHAPTER2: {
        itemType: "bookSection",
        title: "Gamma chapter",
        bookTitle: "Collected Gammas",
        publisher: "G Press",
        pages: "5-30",
        date: "2020",
        series: "",
        creators: [
          { creatorType: "author", firstName: "Gina", lastName: "Gamma" },
          { creatorType: "author", name: "Gamma Consortium" },
          { creatorType: "editor", firstName: "Ugo", lastName: "Gialli" },
          { creatorType: "seriesEditor", firstName: "Sara", lastName: "Serie" },
          { creatorType: "contributor", firstName: "Not", lastName: "Cited" },
        ],
      },
    });
    const input = await dir.file("chapter.docx", await makeDocx(para(zcite({ keys: "CHAPTER2" }))));
    const out = await h.call("inject_citations", { file_path: input });
    const [c] = citations(await readDocumentXml(await readFile(out.json.output_path)));
    expect(c.citationItems[0].itemData).toEqual({
      type: "chapter",
      title: "Gamma chapter",
      author: [{ family: "Gamma", given: "Gina" }, { literal: "Gamma Consortium" }],
      editor: [{ family: "Gialli", given: "Ugo" }],
      "collection-editor": [{ family: "Serie", given: "Sara" }],
      issued: { "date-parts": [[2020]] },
      "container-title": "Collected Gammas",
      page: "5-30",
      publisher: "G Press",
    });
    expect(c.properties.formattedCitation).toBe("(Gamma & Gamma Consortium, 2020)");
    const r = await expectValidDocx(await readFile(out.json.output_path));
    expect(r.rendered!.bibliography[0]).toContain("In U. Gialli (Ed.), Collected Gammas (pp. 5–30). G Press.");
  });

  it("IC-03 attributi locator/prefix/suffix nel field code", async () => {
    serveItems(h, { SMITH222: SMITH });
    const input = await dir.file(
      "attrs.docx",
      await makeDocx(para(zcite({ keys: "SMITH222", locator: "pp. 12-15", prefix: "see ", suffix: ", emphasis added" })))
    );
    const out = await h.call("inject_citations", { file_path: input });
    const [c] = citations(await readDocumentXml(await readFile(out.json.output_path)));
    expect(c.citationItems[0]).toMatchObject({ locator: "pp. 12-15", prefix: "see ", suffix: ", emphasis added" });
    await expectValidDocx(await readFile(out.json.output_path));
  });

  // Testo provvisorio = rendering di citeproc con lo stile CSL vero (vancouver: stesse parti, tra [] invece di ())
  it.each<CitationStyle>(["apa", "harvard", "chicago", "ieee", "vancouver"])(
    "IC-03b stile %s: locator, prefix e suffix nel testo visibile come li rende Zotero",
    async (style) => {
      serveItems(h, { SMITH222: SMITH });
      const input = await dir.file(`attrs-${style}.docx`, await makeDocx(para(zcite({ keys: "SMITH222", num: "1", locator: "12-15", prefix: "see", suffix: ", fig. 2" }))));
      const out = await h.call("inject_citations", { file_path: input, style });
      expect(out.isError).toBe(false);
      const r = await expectValidDocx(await readFile(out.json.output_path), { style });
      const visible = r.citations[0].visible;
      expect(visible).toBe(
        {
          apa: "(see Smith, 2023, pp. 12–15, fig. 2)",
          harvard: "(see Smith, 2023, pp. 12–15, fig. 2)",
          chicago: "(see Smith 2023, 12–15, fig. 2)",
          ieee: "see [1, pp. 12–15], fig. 2",
          vancouver: "[see 1, fig. 2]",
        }[style]
      );
      expect(style === "vancouver" ? visible.replace(/^\[(.*)\]$/, "($1)") : visible).toBe(r.rendered!.citations[0]);
    }
  );

  it("IC-04 stile ieee con num → [n]; senza num → [?] e warning", async () => {
    serveItems(h, { SMITH222: SMITH, PAIR2222: DOE_ROE });
    const input = await dir.file(
      "ieee.docx",
      await makeDocx(para(zcite({ keys: "SMITH222", num: "1" })) + para(zcite({ keys: "PAIR2222" })))
    );
    const out = await h.call("inject_citations", { file_path: input, style: "ieee" });
    expect(out.json.warnings).toEqual([expect.stringContaining("1/2")]);
    expect(out.json.warnings[0]).toMatch(/show \[\?\] until the user runs Zotero → Refresh in Word.*num="N"/);
    const xml = await readDocumentXml(await readFile(out.json.output_path));
    expect(xml).toContain("[1]");
    expect(xml).toContain("[?]");
    // struttura valida; "[?]" non corrisponde al numero che Zotero scriverà al Refresh
    const report = await expectValidDocx(await readFile(out.json.output_path), { style: "ieee", allowMismatches: true });
    expect(report.mismatches).toEqual([expect.stringContaining('"[?]"')]);
  });

  it("IC-05 vancouver con tutti i num → nessun warning", async () => {
    serveItems(h, { SMITH222: SMITH });
    const input = await dir.file("v.docx", await makeDocx(para(zcite({ keys: "SMITH222", num: "1" }))));
    const out = await h.call("inject_citations", { file_path: input, style: "vancouver" });
    expect(out.json).not.toHaveProperty("warnings");
  });

  it("IC-06 nessun zcite → found 0, output scritto, nessuna chiamata Zotero", async () => {
    const input = await dir.file("plain.docx", await makeDocx(para("No citations here.")));
    const out = await h.call("inject_citations", { file_path: input });
    expect(out.json).toEqual({
      output_path: join(dir.path, "plain_cited.docx"),
      citations_found: 0,
      citations_injected: 0,
      warnings: [expect.stringMatching(/^No <zcite> placeholders found: the output is an unchanged copy\..*footnotes/)],
    });
    await expect(stat(out.json.output_path)).resolves.toBeTruthy();
    expect(h.net.calls).toHaveLength(0);
  });

  it("IC-07 unicode in autori/titoli: testo visibile ed XML ben formato", async () => {
    serveItems(h, {
      UNI22222: article("UNI22222", {
        title: "Über «Lernen» & 学习",
        creators: [{ creatorType: "author", firstName: "Jürgen", lastName: "Müller-Ødegård" }],
        date: "2021",
      }),
      NAUTH222: article("NAUTH222", { title: "机器学习的一个非常非常长的标题，超过三十个字符的那种标题文本再加上十个字符的内容", creators: [], date: "" }),
    });
    const input = await dir.file("ünï.docx", await makeDocx(para("Testo ", zcite({ keys: "UNI22222" }), " e ", zcite({ keys: "NAUTH222" }))));
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
    expect(json.hint).toMatch(/lowercase \.docx: convert \.doc, \.odt or \.rtf/);
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
      expectToolError(await h.call("inject_citations", { file_path: input }), /^Invalid \.docx file: not a readable ZIP archive \(.*\)\. The file is not a Word document or is corrupted: create it again as \.docx/);
    });

    it("IC-12 zip valido senza word/document.xml → isError che cita document.xml", async () => {
      const input = await dir.file("nodoc.docx", await makeDocx("", { omitDocument: true }));
      expectToolError(await h.call("inject_citations", { file_path: input }), "word/document.xml not found. The file is not a Word document or is corrupted");
    });

    it("IC-13 zip troncato → isError", async () => {
      const full = await makeDocx(para(zcite({ keys: "SMITH222" })));
      const input = await dir.file("truncated.docx", full.subarray(0, Math.floor(full.length / 2)));
      expectToolError(await h.call("inject_citations", { file_path: input }));
    });

    it.skipIf(process.getuid?.() === 0)("IC-14b cartella non scrivibile → errore strutturato che dice di copiare il file altrove", async () => {
      serveItems(h, { SMITH222: SMITH });
      const ro = join(dir.path, "readonly");
      await mkdir(ro);
      const input = join(ro, "paper.docx");
      await writeFile(input, await makeDocx(para(zcite({ keys: "SMITH222" }))));
      await chmod(ro, 0o555);
      try {
        const json = expectErrorJson(await h.call("inject_citations", { file_path: input }), "Cannot read the file or write the _cited copy next to it (EACCES)");
        expect(json.hint).toMatch(/^Copy the \.docx to a folder this server can write to/);
      } finally {
        await chmod(ro, 0o755);
      }
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
      serveItems(h, { SMITH222: SMITH });
      const input = await dir.file("missingkey.docx", await makeDocx(para(zcite({ keys: "MISS2222" })) + para(zcite({ keys: "SMITH222,MISS3333" }))));
      const out = await h.call("inject_citations", { file_path: input });
      expectToolError(out, "2 cited key(s) not found in the library: MISS2222, MISS3333. No file was written.");
      expect(out.text).toMatch(/search_library.*add_items_by_doi/);
      expect(out.text).not.toMatch(/\b404\b/);
      await expect(stat(join(dir.path, "missingkey_cited.docx"))).rejects.toThrow();
    });

    it.each([
      ["../tags", "../tags"],
      ["AB?C", "AB?C"],
      ["SMITH222,../items/X", "../items/X"],
      ["SMITH001", "SMITH001"],
      ["SMITH222,abcd2345", "abcd2345"],
      ["ABCDE2345", "ABCDE2345"],
      ["SMITHOOO", "SMITHOOO"],
    ])(
      'IC-24 chiave <zcite> non valida per Zotero "%s" → isError che nomina "%s", nessuna richiesta, nessun output',
      async (keys, bad) => {
        const input = await dir.file("badkey.docx", await makeDocx(para(zcite({ keys }))));
        const out = await h.call("inject_citations", { file_path: input });
        expectToolError(out, `Invalid Zotero item key(s) in <zcite>: ${bad} (a key is 8 characters from 23456789ABCDEFGHIJKLMNPQRSTUVWXYZ)`);
        expect(out.text).not.toContain("SMITH222");
        expect(out.text).toMatch(/No file was written\. Use the keys returned by search_library/);
        expect(h.net.calls).toHaveLength(0);
        await expect(stat(join(dir.path, "badkey_cited.docx"))).rejects.toThrow();
      }
    );

    it.each([403, 429, 500, 503])("IC-17 HTTP %i → isError", async (status) => {
      h.net.on("GET", ITEM_ROUTE, zError(status));
      const input = await dir.file(`e${status}.docx`, await makeDocx(para(zcite({ keys: "SMITH222" }))));
      expectApiError(await h.call("inject_citations", { file_path: input }), status);
    });

    it("IC-18 errore di rete → isError", async () => {
      h.net.on("GET", ITEM_ROUTE, networkError());
      const input = await dir.file("net.docx", await makeDocx(para(zcite({ keys: "SMITH222" }))));
      expectApiError(await h.call("inject_citations", { file_path: input }));
    });
  });

  it("IC-19 il .docx di output resta uno zip valido con le altre parti intatte", async () => {
    serveItems(h, { SMITH222: SMITH });
    const input = await dir.file("parts.docx", await makeDocx(para(zcite({ keys: "SMITH222" }))));
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
    serveItems(h, { SMITH222: SMITH });
    const sub = join(dir.path, "thesis.docx.d");
    await mkdir(sub);
    const input = join(sub, "paper.docx");
    await (await import("node:fs/promises")).writeFile(input, await makeDocx(para(zcite({ keys: "SMITH222" }))));
    const out = await h.call("inject_citations", { file_path: input });
    expect(out.isError).toBe(false);
    expect(out.json.output_path).toBe(join(sub, "paper_cited.docx"));
  });

  // Run con attributi (<w:r w:rsidR="…">, revisioni di Word): prima venivano saltate in silenzio
  // (found ma injected 0); ora vengono iniettate. I documenti senza attributi non cambiano (test golden).
  it("IC-25a run con attributi, tag unico nella run (caso A) → iniettata", async () => {
    serveItems(h, { SMITH222: SMITH });
    const body = '<w:p><w:r w:rsidR="00AB12CD"><w:t>&lt;zcite keys=&quot;SMITH222&quot;/&gt;</w:t></w:r></w:p>';
    const input = await dir.file("rsid-a.docx", await makeDocx(body));
    const out = await h.call("inject_citations", { file_path: input });
    expect(out.isError).toBe(false);
    expect(out.json).toMatchObject({ citations_found: 1, citations_injected: 1 });
    const xml = await readDocumentXml(await readFile(out.json.output_path));
    expect(xml).toContain("ADDIN ZOTERO_ITEM CSL_CITATION");
    expect(xml).not.toContain("zcite");
    await expectValidDocx(await readFile(out.json.output_path), { libraryPath: `users/${USER_ID}` });
  });

  it("IC-25b run con attributi, tag inline con altro testo (caso B) → iniettata, testo intorno conservato", async () => {
    serveItems(h, { SMITH222: SMITH });
    const body = '<w:p><w:r w:rsidR="00AB12CD"><w:t xml:space="preserve">Before &lt;zcite keys=&quot;SMITH222&quot;/&gt; after</w:t></w:r></w:p>';
    const input = await dir.file("rsid-b.docx", await makeDocx(body));
    const out = await h.call("inject_citations", { file_path: input });
    expect(out.isError).toBe(false);
    expect(out.json).toMatchObject({ citations_found: 1, citations_injected: 1 });
    const xml = await readDocumentXml(await readFile(out.json.output_path));
    expect(xml).toContain("ADDIN ZOTERO_ITEM CSL_CITATION");
    expect(xml).toContain("Before ");
    expect(xml).toContain(" after");
    expect(xml).not.toContain("zcite");
    await expectValidDocx(await readFile(out.json.output_path), { libraryPath: `users/${USER_ID}` });
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
      SMITH222: SMITH,
      PAIR2222: DOE_ROE,
      MANY2222: article("MANY2222", {
        title: "Many Authors",
        date: "2020-06-25",
        creators: ["Pessoa", "Sadykov", "Uchoa", "Vanderbeck"].map((lastName) => ({ creatorType: "author", firstName: "A.", lastName })),
      }),
      HALLMANN: article("HALLMANN", {
        title: "Insects",
        date: "2017-10-18",
        creators: [
          { creatorType: "author", firstName: "Caspar A.", lastName: "Hallmann" },
          { creatorType: "author", firstName: "Hans", lastName: "de Kroon" },
        ],
      }),
      UNI22222: article("UNI22222", { title: "Über «Lernen» & 学习", date: "2021", creators: [{ creatorType: "author", firstName: "Jürgen", lastName: "Müller-Ødegård" }] }),
      NAUTH222: article("NAUTH222", { title: "Anonymous memo", date: "2019", creators: [] }),
      CNSRTIUM: { itemType: "report", title: "Consortium report", date: "2021", creators: [{ creatorType: "author", name: "Test Consortium" }] },
    };
    // num coerenti con l'ordine di prima citazione, come li numera citeproc
    const BODY = (numbered: boolean) =>
      para("Single ", zcite({ keys: "SMITH222", ...(numbered && { num: "1" }) })) +
      para("Pair and many ", zcite({ keys: "PAIR2222,MANY2222", ...(numbered && { num: "2,3" }) })) +
      para("Locator ", zcite({ keys: "HALLMANN", locator: "pp. 12-15", prefix: "see ", suffix: ", fig. 2", ...(numbered && { num: "4" }) })) +
      para("Unicode, no author, institution ", zcite({ keys: "UNI22222,NAUTH222,CNSRTIUM", ...(numbered && { num: "5-7" }) })) +
      para("Repeated ", zcite({ keys: "SMITH222", ...(numbered && { num: "1" }) }));

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
      const input = await dir.file("group.docx", await makeDocx(para(zcite({ keys: "SMITH222,PAIR2222" }))));
      const out = await h.call("inject_citations", { file_path: input, library_type: "group", library_id: "777" });
      expect(out.isError).toBe(false);
      await expectValidDocx(await readFile(out.json.output_path), { libraryPath: "groups/777" });
    });

    /**
     * Preferenze del documento (H-W1, test/WORD_CHECKLIST.md): senza ZOTERO_PREF_* il primo Refresh apriva Document
     * Preferences proponendo l'ultimo stile di Zotero (job word-proxy). Ora il prodotto le scrive con lo stile
     * dell'iniezione e fieldType Field; il validatore ricompone ZOTERO_PREF_1…n e controlla stile, fieldType, content
     * type e relazione. Le altre ipotesi (H-W2..H-W5) le decide word-proxy. inject.js scrive le stesse preferenze.
     */
    it.each<CitationStyle>(["apa", "harvard", "chicago", "ieee", "vancouver"])(
      "IC-V-H1 stile %s: docProps/custom.xml con ZOTERO_PREF_* (stile dell'iniezione, fieldType Field)",
      async (style) => {
        serveItems(h, LIBRARY);
        const numbered = style === "ieee" || style === "vancouver";
        const input = await dir.file(`prefs-${style}.docx`, await makeDocx(BODY(numbered)));
        const out = await h.call("inject_citations", { file_path: input, style });
        const r = await expectValidDocx(await readFile(out.json.output_path), { style, libraryPath: `users/${USER_ID}` });
        expect(r.parity.hasDocumentPrefs).toBe(true);
        expect(r.documentPrefs).toEqual({ styleId: styleId(style), fieldType: "Field", chunks: 1 });
      }
    );

    it("IC-V-H1c parte custom-properties esistente non unibile → preferenze non scritte, parte intatta, avviso", async () => {
      serveItems(h, LIBRARY);
      const zip = await JSZip.loadAsync(await makeDocx(BODY(false)));
      const odd = '<?xml version="1.0"?><x:Other xmlns:x="y"/>';
      zip.file("docProps/custom.xml", odd);
      const input = await dir.file("odd.docx", await zip.generateAsync({ type: "nodebuffer" }));
      const out = await h.call("inject_citations", { file_path: input, style: "apa" });
      expect(out.isError).toBe(false);
      expect(out.json.warnings.join(" ")).toContain("Zotero document preferences not written");
      expect(await (await JSZip.loadAsync(await readFile(out.json.output_path))).file("docProps/custom.xml")!.async("string")).toBe(odd);
    });

    it("IC-V-H1b preferenze già presenti (documento gestito da Zotero) → lasciate come sono, con un avviso", async () => {
      serveItems(h, LIBRARY);
      const zip = await JSZip.loadAsync(await makeDocx(BODY(false)));
      const zotero = '<property fmtid="{D5CDD505-2E9C-101B-9397-08002B2CF9AE}" pid="2" name="ZOTERO_PREF_1"><vt:lpwstr>KEEP</vt:lpwstr></property>';
      zip.file("docProps/custom.xml", `<?xml version="1.0"?><Properties xmlns:vt="v">${zotero}</Properties>`);
      const input = await dir.file("managed.docx", await zip.generateAsync({ type: "nodebuffer" }));
      const out = await h.call("inject_citations", { file_path: input, style: "ieee" });
      expect(out.isError).toBe(false);
      expect(out.json.warnings.join(" ")).toContain("already has Zotero document preferences");
      const custom = await (await JSZip.loadAsync(await readFile(out.json.output_path))).file("docProps/custom.xml")!.async("string");
      expect(custom).toBe(`<?xml version="1.0"?><Properties xmlns:vt="v">${zotero}</Properties>`);
    });
  });
});
