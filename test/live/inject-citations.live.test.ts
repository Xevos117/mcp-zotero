import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFile } from "node:fs/promises";
import { live, startLive, LiveServer, FAKE_KEY, createItems, title } from "./helpers/live.js";
import { expectUrisResolve } from "./helpers/docx.js";
import { makeDocx, makeOdt, odtPara, para, zcite, readDocumentXml, tempDir, TempDir } from "../helpers/fixtures.js";
import { expectValidOdt } from "../helpers/citation-validate.js";
import { expectValidDocx, CitationStyle } from "../helpers/docx-validate.js";

describe.skipIf(!live.enabled)("inject_citations (live)", () => {
  let s: LiveServer;
  let dir: TempDir;
  beforeAll(async () => {
    s = await startLive();
    dir = await tempDir();
  });
  afterAll(async () => {
    await s?.close();
    await dir?.cleanup();
  });

  const body = (numbered: boolean) => {
    const f = live.fixtures;
    const n = (v: string): Record<string, string> => (numbered ? { num: v } : {});
    return (
      para("Single ", zcite({ keys: f.article, ...n("1") })) +
      para("Multi ", zcite({ keys: `${f.many},${f.book}`, ...n("2,3") })) +
      para("Locator ", zcite({ keys: f.inSub, locator: "pp. 12-15", prefix: "see ", ...n("4") })) +
      para(`Inline ${zcite({ keys: f.noAuthor, ...n("5") })} in one run.`) +
      para("Repeated ", zcite({ keys: f.article, ...n("1") }))
    );
  };

  it.each<CitationStyle>(["apa", "harvard", "chicago", "ieee", "vancouver"])(
    "LIVE-IC-01 stile %s su voci reali → docx valido (struttura, schema, citeproc) e URI risolvibili via API",
    async (style) => {
      const numbered = style === "ieee" || style === "vancouver";
      const input = await dir.file(`live-${style}.docx`, await makeDocx(body(numbered)));
      const r = await s.call("inject_citations", { file_path: input, style });
      expect(r.isError, r.text).toBe(false);
      expect(r.json).toMatchObject({ citations_found: 5, citations_injected: 5 });
      const report = await expectValidDocx(await readFile(r.json.output_path), { style, libraryPath: live.libraryPath });
      expect(report.rendered!.bibliography).toHaveLength(5);
      await expectUrisResolve(report);
    }
  );

  it("LIVE-IC-02 chiave inesistente → isError che la nomina (come inject.js), nessun output", async () => {
    const input = await dir.file("live-missing.docx", await makeDocx(para(zcite({ keys: FAKE_KEY }))));
    const r = await s.call("inject_citations", { file_path: input });
    expect(r.isError).toBe(true);
    expect(r.text).toContain(`1 cited key(s) not found in the library: ${FAKE_KEY}`);
    await expect(readFile(input.replace(/\.docx$/, "_cited.docx"))).rejects.toThrow();
  });

  it("LIVE-IC-03 override library_type user → stessi URI della libreria utente", async () => {
    const input = await dir.file("live-override.docx", await makeDocx(para(zcite({ keys: live.fixtures.book }))));
    const r = await s.call("inject_citations", { file_path: input, library_type: "user", library_id: live.userId });
    const report = await expectValidDocx(await readFile(r.json.output_path), { libraryPath: live.libraryPath });
    await expectUrisResolve(report);
  });

  // Ramo Pandoc: dipende dalla ricerca reale dell'API per risolvere i citekey Better BibTeX (campo
  // searchable). Tutto ciò che la run crea porta i marcatori e viene rimosso dal teardown.
  it("LIVE-IC-P01 marcatori Pandoc per chiave Zotero → citazioni + bibliografia, URI risolvibili", async () => {
    const f = live.fixtures;
    const input = await dir.file("live-pandoc-key.docx", await makeDocx(para(`Shown [@${f.article}] and also [see @${f.book}, p. 2].`)));
    const r = await s.call("inject_citations", { file_path: input });
    expect(r.isError, r.text).toBe(false);
    expect(r.json).toMatchObject({ citations_found: 2, citations_injected: 2 });
    const report = await expectValidDocx(await readFile(r.json.output_path), { libraryPath: live.libraryPath });
    await expectUrisResolve(report);
  });

  // Copre il percorso "Citation Key:" in Extra. La ricerca q=<citekey>&qmode=everything può non trovare una
  // voce appena creata (indice full-text in ritardo) o non coprire Extra: in quel caso il resolver ricade su
  // una scansione paginata di items/top, che legge i dati delle voci e la trova comunque. Il campo nativo
  // citationKey è coperto da LIVE-IC-P06.
  it("LIVE-IC-P02 citekey Better BibTeX (riga 'Citation Key:' in Extra) risolto via ricerca API", async () => {
    const citekey = `mztck${live.runId}`.replace(/[^A-Za-z0-9]/g, "");
    const [key] = await createItems([
      {
        itemType: "journalArticle",
        title: title("pandoc citekey"),
        creators: [{ creatorType: "author", firstName: "Carla", lastName: "Esposito" }],
        date: "2024",
        extra: `Citation Key: ${citekey}`,
      },
    ]);
    const input = await dir.file("live-pandoc-citekey.docx", await makeDocx(para(`As in [@${citekey}].`)));
    const r = await s.call("inject_citations", { file_path: input });
    expect(r.isError, r.text).toBe(false);
    expect(r.json).toMatchObject({ citations_found: 1, citations_injected: 1 });
    // il citekey è risolto nella chiave Zotero della voce creata: l'URI iniettato la nomina
    const xml = await readDocumentXml(await readFile(r.json.output_path));
    expect(xml).toContain(`/items/${key}`);
    expect(xml).not.toContain(citekey);
    const report = await expectValidDocx(await readFile(r.json.output_path), { libraryPath: live.libraryPath });
    await expectUrisResolve(report);
  });

  // Campo NATIVO citationKey (schema Zotero 42, scrivibile dalla Web API): la ricerca q non lo indicizza,
  // quindi il citekey si risolve solo con la scansione di items/top.
  it("LIVE-IC-P06 citekey nel campo nativo citationKey → risolto nella chiave Zotero, URI risolvibile", async () => {
    const citekey = `mztnative${live.runId}`.replace(/[^A-Za-z0-9]/g, "");
    const [key] = await createItems([
      {
        itemType: "journalArticle",
        title: title("pandoc native citekey"),
        creators: [{ creatorType: "author", firstName: "Bruno", lastName: "Ferri" }],
        date: "2023",
        citationKey: citekey,
      },
    ]);
    const input = await dir.file("live-pandoc-native.docx", await makeDocx(para(`Native [@${citekey}, p. 3] and inline @${citekey}.`)));
    const r = await s.call("inject_citations", { file_path: input });
    expect(r.isError, r.text).toBe(false);
    expect(r.json).toMatchObject({ citations_found: 2, citations_injected: 2 });
    const xml = await readDocumentXml(await readFile(r.json.output_path));
    expect(xml).toContain(`/items/${key}`);
    expect(xml).not.toContain(`@${citekey}`);
    const report = await expectValidDocx(await readFile(r.json.output_path), { libraryPath: live.libraryPath });
    expect(report.citations[0].json.citationItems[0]).toMatchObject({ locator: "p. 3" });
    await expectUrisResolve(report);
  });

  // Le forme che l'agent smoke non può scrivere (il ";" è vietato nei comandi Bash dell'harness): più chiavi in
  // un marcatore, autore soppresso, @key in linea risolto e uno non risolto che resta testo.
  const pandocText = (nobody: string): string => {
    const f = live.fixtures;
    return `Group [@${f.many}; @${f.book}], suppressed [-@${f.article}], inline @${f.inSub} and unresolved @${nobody}.`;
  };

  it("LIVE-IC-P04 Pandoc docx ieee: [@A; @B], [-@C], @D in linea, @sconosciuto in linea resta testo", async () => {
    const nobody = `mztnobody${live.runId}`.replace(/[^A-Za-z0-9]/g, "");
    const input = await dir.file("live-pandoc-forms.docx", await makeDocx(para(pandocText(nobody))));
    const r = await s.call("inject_citations", { file_path: input, style: "ieee" });
    expect(r.isError, r.text).toBe(false);
    expect(r.json).toMatchObject({ citations_found: 3, citations_injected: 3 });
    expect((r.json.warnings ?? []).join(" ")).toMatch(new RegExp(`@${nobody}.*kept as text`));
    const xml = await readDocumentXml(await readFile(r.json.output_path));
    expect(xml).toContain(`@${nobody}`);
    expect(xml).not.toContain(`[@${live.fixtures.many}`);
    const report = await expectValidDocx(await readFile(r.json.output_path), { style: "ieee", libraryPath: live.libraryPath });
    // una citazione con due voci, poi una e una: 4 voci distinte in bibliografia
    expect(report.citations.map((c) => c.json.citationItems.length)).toEqual([2, 1, 1]);
    expect(report.citations[1].json.citationItems[0]).toMatchObject({ "suppress-author": true });
    expect(report.rendered!.bibliography).toHaveLength(4);
    await expectUrisResolve(report);
  });

  it("LIVE-IC-P05 Pandoc odt apa: stesse forme → reference mark validi", async () => {
    const nobody = `mztnobody${live.runId}`.replace(/[^A-Za-z0-9]/g, "");
    const input = await dir.file("live-pandoc-forms.odt", await makeOdt(odtPara(pandocText(nobody))));
    const r = await s.call("inject_citations", { file_path: input });
    expect(r.isError, r.text).toBe(false);
    expect(r.json).toMatchObject({ output_path: input.replace(/\.odt$/, "_cited.odt"), citations_found: 3, citations_injected: 3 });
    expect((r.json.warnings ?? []).join(" ")).toMatch(/kept as text/);
    const report = await expectValidOdt(await readFile(r.json.output_path), { libraryPath: live.libraryPath });
    expect(report.citations).toHaveLength(3);
  });

  it("LIVE-IC-P03 citekey sconosciuto → isError che lo nomina, nessun output", async () => {
    const nope = `mztnope${live.runId}`.replace(/[^A-Za-z0-9]/g, "");
    const input = await dir.file("live-pandoc-unknown.docx", await makeDocx(para(`Missing [@${nope}].`)));
    const r = await s.call("inject_citations", { file_path: input });
    expect(r.isError).toBe(true);
    expect(r.text).toContain(nope);
    await expect(readFile(input.replace(/\.docx$/, "_cited.docx"))).rejects.toThrow();
  });
});
