import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFile, mkdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { XMLValidator } from "fast-xml-parser";
import JSZip from "jszip";
import {
  Harness,
  startHarness,
  expectValidationError,
  expectSoftError,
  expectToolError,
} from "../helpers/mcp-harness.js";
import { networkError } from "../helpers/fake-net.js";
import { ZBASE, zSingle, zError, article, USER_ID } from "../helpers/zotero-fake.js";
import { makeDocx, para, zcite, readDocumentXml, tempDir, TempDir } from "../helpers/fixtures.js";

const ITEM_ROUTE = new RegExp(`^${ZBASE.replace(/\./g, "\\.")}/items/[A-Z0-9]+$`);

/** Zotero: GET /items/KEY restituisce l'item dalla mappa (404 se assente). */
function serveItems(h: Harness, items: Record<string, Record<string, unknown>>) {
  h.net.on("GET", ITEM_ROUTE, (req) => {
    const key = req.url.pathname.split("/").pop()!;
    const item = items[key];
    return item ? zSingle({ key, ...item }) : zError(404, "Item not found");
  });
}

/** Estrae i JSON CSL_CITATION dai field code del documento. */
function citations(xml: string): Array<Record<string, any>> {
  const out: Array<Record<string, any>> = [];
  const re = /ADDIN ZOTERO_ITEM CSL_CITATION (.*?) <\/w:instrText>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const json = m[1]
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&amp;/g, "&");
    out.push(JSON.parse(json));
  }
  return out;
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
  });

  it("IC-08 file non .docx → errore morbido senza rete", async () => {
    const json = expectSoftError(await h.call("inject_citations", { file_path: "/tmp/document.pdf" }), "File must be a .docx file");
    expect(json.file_path).toBe("/tmp/document.pdf");
    expect(h.net.calls).toHaveLength(0);
  });

  it("IC-09 estensione maiuscola .DOCX → rifiutata (controllo case-sensitive)", async () => {
    expectSoftError(await h.call("inject_citations", { file_path: "/tmp/PAPER.DOCX" }), "File must be a .docx file");
  });

  it("IC-10 file inesistente → isError (ENOENT)", async () => {
    expectToolError(await h.call("inject_citations", { file_path: join(dir.path, "missing.docx") }), "ENOENT");
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
    it("IC-16 chiave inesistente (404) → isError, nessun output scritto", async () => {
      serveItems(h, {});
      const input = await dir.file("missingkey.docx", await makeDocx(para(zcite({ keys: "NOPE0001" }))));
      expectToolError(await h.call("inject_citations", { file_path: input }), "404");
      await expect(stat(join(dir.path, "missingkey_cited.docx"))).rejects.toThrow();
    });

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
});
