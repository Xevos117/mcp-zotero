import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Harness, startHarness, expectErrorJson } from "../helpers/mcp-harness.js";
import { ZBASE, zSingle, zError, article, USER_ID } from "../helpers/zotero-fake.js";
import { makeDocx, makeOdt, odtPara, odtSpan, para, zcite, readContentXml, tempDir, TempDir } from "../helpers/fixtures.js";
import { expectValidOdt } from "../helpers/citation-validate.js";
import { CitationStyle } from "../helpers/docx-validate.js";

/**
 * inject_citations sul percorso LibreOffice (.odt, #37): rispecchia le righe IC-V del percorso Word.
 * Reference mark al posto dei field code, bibliografia in una text:section, preferenze in meta.xml.
 */

const ITEM_ROUTE = new RegExp(`^${ZBASE.replace(/\./g, "\\.")}/items/[A-Z0-9]+$`);
function serveItems(h: Harness, items: Record<string, Record<string, unknown>>) {
  h.net.on("GET", ITEM_ROUTE, (req) => {
    const key = req.url.pathname.split("/").pop()!;
    const it = items[key];
    return it ? zSingle({ key, ...it }) : zError(404, "Item not found");
  });
}

const LIBRARY: Record<string, Record<string, unknown>> = {
  SMITH222: article("SMITH222", { title: "On Testing", creators: [{ creatorType: "author", firstName: "John", lastName: "Smith" }], date: "2023" }),
  PAIR2222: article("PAIR2222", { title: "Pair Paper", creators: [{ creatorType: "author", firstName: "Jane", lastName: "Doe" }, { creatorType: "author", firstName: "Rick", lastName: "Roe" }], date: "2019-03-01" }),
  MANY2222: article("MANY2222", { title: "Many Authors", date: "2020-06-25", creators: ["Pessoa", "Sadykov", "Uchoa", "Vanderbeck"].map((lastName) => ({ creatorType: "author", firstName: "A.", lastName })) }),
  HALLMANN: article("HALLMANN", { title: "Insects", date: "2017-10-18", creators: [{ creatorType: "author", firstName: "Caspar A.", lastName: "Hallmann" }, { creatorType: "author", firstName: "Hans", lastName: "de Kroon" }] }),
  UNI22222: article("UNI22222", { title: "Über «Lernen» & 学习", date: "2021", creators: [{ creatorType: "author", firstName: "Jürgen", lastName: "Müller-Ødegård" }] }),
  NAUTH222: article("NAUTH222", { title: "Anonymous memo", date: "2019", creators: [] }),
  CNSRTIUM: { itemType: "report", title: "Consortium report", date: "2021", creators: [{ creatorType: "author", name: "Test Consortium" }] },
};

const BODY = (numbered: boolean) =>
  odtPara("Single ", zcite({ keys: "SMITH222", ...(numbered && { num: "1" }) })) +
  odtPara("Pair and many ", zcite({ keys: "PAIR2222,MANY2222", ...(numbered && { num: "2,3" }) })) +
  odtPara("Locator ", zcite({ keys: "HALLMANN", locator: "pp. 12-15", prefix: "see ", suffix: ", fig. 2", ...(numbered && { num: "4" }) })) +
  odtPara("Unicode, no author, institution ", zcite({ keys: "UNI22222,NAUTH222,CNSRTIUM", ...(numbered && { num: "5-7" }) })) +
  odtPara("Repeated ", zcite({ keys: "SMITH222", ...(numbered && { num: "1" }) }));

describe("inject_citations odt (ICO)", () => {
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

  it("ICO-01 un reference mark, bibliografia, *_cited.odt; originale intatto", async () => {
    serveItems(h, { SMITH222: LIBRARY.SMITH222 });
    const input = await dir.file("paper.odt", await makeOdt(odtPara("As shown ", zcite({ keys: "SMITH222" }), " before.")));
    const original = await readFile(input);
    const out = await h.call("inject_citations", { file_path: input });
    expect(out.isError, out.text).toBe(false);
    expect(out.json).toEqual({ output_path: join(dir.path, "paper_cited.odt"), citations_found: 1, citations_injected: 1 });
    const xml = await readContentXml(await readFile(out.json.output_path));
    expect(xml).toContain("text:reference-mark-start");
    expect(xml).toContain("ZOTERO_ITEM CSL_CITATION");
    expect(xml).toContain("As shown ");
    expect(xml).not.toContain("zcite");
    expect(xml).not.toContain("plainCitation");
    await expectValidOdt(await readFile(out.json.output_path), { libraryPath: `users/${USER_ID}` });
    expect((await readFile(input)).equals(original)).toBe(true);
  });

  it.each<CitationStyle>(["apa", "harvard", "chicago", "ieee", "vancouver"])(
    "ICO-V01 stile %s: struttura, schema CSL, URI, citeproc (citazioni + bibliografia), preferenze ReferenceMark",
    async (style) => {
      serveItems(h, LIBRARY);
      const numbered = style === "ieee" || style === "vancouver";
      const input = await dir.file(`matrix-${style}.odt`, await makeOdt(BODY(numbered)));
      const out = await h.call("inject_citations", { file_path: input, style });
      expect(out.isError, out.text).toBe(false);
      expect(out.json).toMatchObject({ citations_found: 5, citations_injected: 5 });
      const r = await expectValidOdt(await readFile(out.json.output_path), { style, libraryPath: `users/${USER_ID}`, requireDocumentPrefs: true });
      expect(r.citations).toHaveLength(5);
      expect(r.rendered!.bibliography).toHaveLength(7);
      expect(r.documentPrefs!.fieldType).toBe("ReferenceMark");
    }
  );

  it("ICO-V02 libreria di gruppo per chiamata → URI /groups/<id>/", async () => {
    h.net.on("GET", /^api\.zotero\.org\/groups\/777\/items\/[A-Z0-9]+$/, (req) => {
      const key = req.url.pathname.split("/").pop()!;
      return zSingle({ key, ...LIBRARY[key] });
    });
    const input = await dir.file("group.odt", await makeOdt(odtPara(zcite({ keys: "SMITH222,PAIR2222" }))));
    const out = await h.call("inject_citations", { file_path: input, library_type: "group", library_id: "777" });
    expect(out.isError, out.text).toBe(false);
    await expectValidOdt(await readFile(out.json.output_path), { libraryPath: "groups/777" });
  });

  it("ICO-02 tag <zcite> spezzato tra più text:span → normalizzato e iniettato", async () => {
    serveItems(h, { SMITH222: LIBRARY.SMITH222 });
    const input = await dir.file("split.odt", await makeOdt(odtPara("See ", odtSpan("&lt;zcite keys=&quot;SM"), odtSpan("ITH222&quot;/&gt;"), " here")));
    const out = await h.call("inject_citations", { file_path: input });
    expect(out.isError, out.text).toBe(false);
    expect(out.json).toMatchObject({ citations_found: 1, citations_injected: 1 });
    const xml = await readContentXml(await readFile(out.json.output_path));
    expect(xml).toContain("text:reference-mark-start");
    expect(xml).toContain("See ");
    expect(xml).toContain(" here");
  });

  it("ICO-03 nessuno zcite → found 0, output .odt scritto", async () => {
    const input = await dir.file("plain.odt", await makeOdt(odtPara("No citations here.")));
    const out = await h.call("inject_citations", { file_path: input });
    expect(out.json).toMatchObject({ citations_found: 0, citations_injected: 0 });
    await expect(readFile(out.json.output_path)).resolves.toBeTruthy();
    expect(h.net.calls).toHaveLength(0);
  });

  describe("selettore di formato", () => {
    it("ICO-04 format 'docx' su un file .odt → errore di estensione", async () => {
      const input = await dir.file("x.odt", await makeOdt(odtPara(zcite({ keys: "SMITH222" }))));
      const json = expectErrorJson(await h.call("inject_citations", { file_path: input, format: "docx" }), "does not match the file extension");
      expect(json.file_path).toBe(input);
    });

    it("ICO-05 un .docx rinominato .odt → errore di contenuto (sniff), nessun output", async () => {
      serveItems(h, { SMITH222: LIBRARY.SMITH222 });
      const input = await dir.file("fake.odt", await makeDocx(para(zcite({ keys: "SMITH222" }))));
      const out = await h.call("inject_citations", { file_path: input });
      expect(out.isError).toBe(true);
      expect(out.text).toMatch(/looks like a Word \.docx/);
    });

    it("ICO-06 un .odt rinominato .docx → errore di contenuto (sniff)", async () => {
      const input = await dir.file("fake.docx", await makeOdt(odtPara(zcite({ keys: "SMITH222" }))));
      const out = await h.call("inject_citations", { file_path: input });
      expect(out.isError).toBe(true);
      expect(out.text).toMatch(/looks like a LibreOffice \.odt/);
    });

    it("ICO-07 estensione non supportata → errore", async () => {
      expectErrorJson(await h.call("inject_citations", { file_path: "/tmp/a.rtf" }), "File must be a .docx (Word) or .odt (LibreOffice) file");
    });
  });
});
