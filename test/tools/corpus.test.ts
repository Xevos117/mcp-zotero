import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { readFile } from "node:fs/promises";
import { Harness, startHarness } from "../helpers/mcp-harness.js";
import { USER_ID, ZBASE, ZItem, zWrite } from "../helpers/zotero-fake.js";
import { makeDocx, para, zcite, tempDir, TempDir } from "../helpers/fixtures.js";
import { CitationStyle, expectValidDocx } from "../helpers/docx-validate.js";
import { FULLTEXT_ROUTE, UNPAYWALL_EMAIL, UPLOAD_HOST, installUploadPipeline } from "../helpers/pdf-pipeline.js";
import { corpusDois, corpusItem, corpusManifest, corpusPdf, corpusRoutes, corpusWork, serveCorpusLibrary } from "../helpers/corpus.js";

/**
 * add_items_by_doi on the real corpus (recorded doi.org responses, test/fixtures/corpus/): the item the
 * product creates, field by field, against the curated item of library.json.
 * Each known difference has a cause:
 * - "source": the registry's data is wrong or incomplete (the product cannot know better);
 * - "product": the data is in the registry response and the conversion loses or mangles it. Each product cause
 *   is an it.fails per work, so fixing the conversion turns it red and the entry has to leave KNOWN.
 */

type Kind = "source" | "product";
const CAUSES: Record<string, [Kind, string]> = {
  place: ["product", "publisher-location di Crossref ignorato (la CSL standard dice publisher-place): luogo perso"],
  event: ["product", "event della CSL ignorato: conferenceName perso"],
  short: ["product", "container-title-short ignorato: journalAbbreviation perso"],
  contributor: ["product", "contributor della CSL persi (relatori della tesi)"],
  jats: ["product", "abstract con il markup JATS di Crossref (<jats:p>) invece del testo"],
  subtitle: ["product", "sottotitolo della CSL perso nel titolo"],
  article: ["product", "tipo CSL article (preprint) importato come journalArticle: repository perso"],
  articleNumber: ["product", "article-number non usato come pagine (riviste senza pagine)"],
  chapterEditor: ["source", "il record Crossref del capitolo non ha i curatori (sono nel record del libro)"],
  chapterTitle: ["source", "Crossref mette il numero del capitolo nel titolo"],
  university: ["source", "l'università è solo nel record Zenodo, non nella CSL di DataCite (publisher Zenodo)"],
  reportType: ["source", "DataCite tipizza il report come article-journal"],
  particles: ["source", "DataCite mette le particelle nel nome (given \"Diego de las\", family \"Casas\")"],
  arxivId: ["source", "l'identificativo arXiv non è nella CSL di DataCite"],
};
/** Known differences: work → field → cause. */
const KNOWN: Record<string, Record<string, keyof typeof CAUSES>> = {
  conneau2020: { place: "place", conferenceName: "event" },
  ivanov2022: { journalAbbreviation: "short" },
  edmond2020: { place: "place", abstractNote: "jats" },
  eve2020: { creators: "chapterEditor", title: "chapterTitle", place: "place", abstractNote: "jats" },
  kochan2017: { title: "subtitle", place: "place", abstractNote: "jats" },
  gualandi2022: { creators: "contributor", university: "university" },
  rda2020: { itemType: "reportType", publisher: "reportType", publicationTitle: "reportType", institution: "reportType" },
  jiang2023: { itemType: "article", publisher: "article", repository: "article", creators: "particles", archiveID: "arxivId" },
  eve2020b: { pages: "articleNumber" },
  peroni2023a: { pages: "articleNumber", journalAbbreviation: "short" },
  peroni2023b: { pages: "articleNumber", journalAbbreviation: "short", abstractNote: "jats" },
};

const IGNORED = new Set(["key", "collections", "tags", "relations"]);

/** Comparable value: "" is absent, DOIs case-insensitive, dates as numbers (2022-2-15 = 2022-02-15). */
function norm(field: string, v: unknown): unknown {
  if (v === "" || v === undefined || (Array.isArray(v) && v.length === 0)) return undefined;
  if (field === "DOI") return String(v).toLowerCase();
  if (field === "date") return String(v).split("-").map(Number).join("-");
  if (field === "creators") {
    return (v as Array<Record<string, string>>).map(({ creatorType, name, firstName, lastName }) =>
      name !== undefined ? { creatorType, name } : { creatorType, firstName, lastName }
    );
  }
  return v;
}

function differences(product: ZItem, curated: ZItem): Record<string, { product: unknown; curated: unknown }> {
  const out: Record<string, { product: unknown; curated: unknown }> = {};
  for (const f of new Set([...Object.keys(product), ...Object.keys(curated)])) {
    if (IGNORED.has(f)) continue;
    const a = norm(f, product[f]);
    const b = norm(f, curated[f]);
    if (JSON.stringify(a) !== JSON.stringify(b)) out[f] = { product: a, curated: b };
  }
  return out;
}

describe("corpus reale: add_items_by_doi contro library.json", () => {
  let h: Harness;
  const created = new Map<string, ZItem>();

  beforeAll(async () => {
    h = await startHarness();
    corpusRoutes(h.net);
    h.net.on("POST", `${ZBASE}/items`, zWrite());
    const out = await h.call("add_items_by_doi", { dois: corpusDois() });
    expect(out.isError, out.text).toBe(false);
    for (const req of h.net.requests("POST", `${ZBASE}/items`)) {
      for (const item of req.json<ZItem[]>()) {
        const work = corpusManifest().works.find((w) => w.sources.doi?.toLowerCase() === String(item.DOI).toLowerCase());
        if (work) created.set(work.id, item);
      }
    }
  });
  afterAll(async () => {
    await h.close();
  });

  it("CORPUS-AID-01 ogni DOI del corpus si risolve dalle cassette e crea un item, senza rete", () => {
    expect(h.net.unmatched).toEqual([]);
    expect([...created.keys()].sort()).toEqual(corpusManifest().works.filter((w) => w.sources.doi).map((w) => w.id).sort());
  });

  const works = corpusManifest().works.filter((w) => w.sources.doi);
  it.each(works.map((w) => w.id))("CORPUS-AID-02 %s: uguale alla voce curata salvo le differenze note", (id) => {
    const diff = differences(created.get(id)!, corpusItem(id));
    const known = KNOWN[id] ?? {};
    const unexpected = Object.fromEntries(Object.entries(diff).filter(([f]) => !known[f]));
    expect(unexpected).toEqual({});
    // a known difference that disappeared must leave the table
    expect(Object.keys(known).filter((f) => !diff[f])).toEqual([]);
  });

  for (const [id, fields] of Object.entries(KNOWN)) {
    for (const cause of new Set(Object.values(fields))) {
      const [kind, why] = CAUSES[cause];
      if (kind !== "product") continue;
      const affected = Object.keys(fields).filter((f) => fields[f] === cause);
      it.fails(`CORPUS-AID-03 ${id} (${affected.join(", ")}): ${why}`, () => {
        const diff = differences(created.get(id)!, corpusItem(id));
        expect(affected.filter((f) => diff[f])).toEqual([]);
      });
    }
  }
});

describe("corpus reale: inject_citations sulla libreria curata", () => {
  let h: Harness;
  let dir: TempDir;
  const K = (id: string) => corpusWork(id).key;

  beforeEach(async () => {
    h = await startHarness();
    dir = await tempDir();
    serveCorpusLibrary(h.net);
  });
  afterEach(async () => {
    await h.close();
    await dir.cleanup();
  });

  // num in order of first citation, as citeproc numbers them
  const BODY = (numbered: boolean) => {
    const n = (v: string) => (numbered ? { num: v } : {});
    return (
      para("Conference paper ", zcite({ keys: K("conneau2020"), ...n("1") })) +
      para("Same author and year ", zcite({ keys: `${K("peroni2023a")},${K("peroni2023b")}`, ...n("2,3") })) +
      para("Chapter with locator ", zcite({ keys: K("eve2020"), locator: "110", prefix: "see", ...n("4") })) +
      para("Edited book, monograph ", zcite({ keys: `${K("edmond2020")},${K("kochan2017")}`, ...n("5,6") })) +
      para("Cyrillic ", zcite({ keys: K("ivanov2022"), ...n("7") })) +
      para("Preprint, thesis, report, web page ", zcite({ keys: ["jiang2023", "gualandi2022", "rda2020", "turingway"].map(K).join(","), ...n("8-11") })) +
      para("Same single author and year ", zcite({ keys: `${K("eve2020")},${K("eve2020b")}`, ...n("4,12") }))
    );
  };

  async function inject(style: CitationStyle) {
    const numbered = style === "ieee" || style === "vancouver";
    const input = await dir.file(`corpus-${style}.docx`, await makeDocx(BODY(numbered)));
    const out = await h.call("inject_citations", { file_path: input, style });
    expect(out.isError, out.text).toBe(false);
    expect(out.json).toMatchObject({ citations_found: 7, citations_injected: 7 });
    return expectValidDocx(await readFile(out.json.output_path), { style, libraryPath: `users/${USER_ID}` });
  }

  it.each<CitationStyle>(["apa", "harvard", "chicago", "ieee", "vancouver"])(
    "CORPUS-IC-01 stile %s: tutte le voci del corpus, docx valido, 12 voci in bibliografia",
    async (style) => {
      const r = await inject(style);
      expect(r.citations).toHaveLength(7);
      expect(r.rendered!.bibliography).toHaveLength(12);
    }
  );

  it("CORPUS-IC-02 apa: coautori o suffissi a/b per stesso autore e anno; cirillico, particelle, autori collettivi", async () => {
    const r = await inject("apa");
    // APA 7: works whose "et al." forms coincide get as many names as needed, not a/b suffixes
    expect(r.rendered!.citations[1]).toBe("(Peroni, Campoy, et al., 2023; Peroni, Hufnagl, et al., 2023)");
    const bib = r.rendered!.bibliography.join("\n");
    expect(bib).toContain("Иванов, Н.");
    expect(bib).toContain("de las Casas, D.");
    expect(bib).toContain("The Turing Way Community");
    expect(bib).toContain("Research Data Alliance FAIR Data Maturity Model Working Group");
    expect(r.rendered!.citations[2]).toContain("p. 110");
    // same author list and year: a/b suffixes (assigned in bibliography order, by title)
    expect(r.rendered!.citations[6]).toBe("(Eve, 2020b, 2020a)");
    expect(r.rendered!.bibliography.find((b) => b.includes("Equivocationary"))).toContain("(2020a)");
    expect(r.rendered!.bibliography.find((b) => b.includes("Violins"))).toContain("(2020b)");
  });

  // the itemData embedded in the field (zoteroItemToCsl) keeps the book title and the editors of a bookSection:
  // what Zotero renders when the item is not in the reader's library (design §7.1)
  it("CORPUS-IC-03 apa: il capitolo cita libro e curatrice (In J. Edmond (Ed.), …) dai dati incorporati", async () => {
    const r = await inject("apa");
    const entry = r.rendered!.bibliography.find((b) => b.includes("Violins in the Subway"))!;
    expect(entry).toContain("In J. Edmond (Ed.), Digital Technology and the Practices of Humanities Research (pp. 105–122)");
  });
});

describe("corpus reale: PDF open access (Unpaywall → PDF dell'editore → testo)", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await startHarness({ unpaywallEmail: UNPAYWALL_EMAIL });
    corpusRoutes(h.net);
    serveCorpusLibrary(h.net);
    h.net.on("POST", `${ZBASE}/items`, zWrite());
    installUploadPipeline(h.net);
  });
  afterEach(async () => {
    await h.close();
  });

  const WITH_PDF = corpusManifest().works.filter((w) => w.pdf).map((w) => w.id);
  // words of each PDF's own text, so the check proves that the real file was parsed
  const TEXT: Record<string, RegExp> = {
    conneau2020: /cross-lingual/i,
    ivanov2022: /[А-Яа-я]{6,}/,
    peroni2023a: /microbiota/i,
  };

  it("CORPUS-PDF-01 find_and_attach_pdfs: i PDF veri del corpus vengono scaricati, caricati intatti e indicizzati", async () => {
    expect(WITH_PDF.sort()).toEqual(Object.keys(TEXT).sort());
    const out = await h.call("find_and_attach_pdfs", { item_keys: WITH_PDF.map((id) => corpusWork(id).key) });
    expect(out.isError, out.text).toBe(false);
    expect(out.json).toMatchObject({ processed: WITH_PDF.length, attached: WITH_PDF.length, errors: 0 });
    const uploads = h.net.requests("POST", `${UPLOAD_HOST}/`).map((r) => r.body!);
    const fulltexts = h.net.requests("PUT", FULLTEXT_ROUTE).map((r) => r.json<{ content: string }>().content);
    for (const id of WITH_PDF) {
      const pdf = corpusPdf(id);
      expect(uploads.some((b) => b.includes(pdf)), `${id} upload`).toBe(true);
      expect(fulltexts.some((t) => TEXT[id].test(t)), `${id} fulltext`).toBe(true);
    }
    expect(h.net.unmatched).toEqual([]);
  });

  it("CORPUS-PDF-02 add_items_by_doi con UNPAYWALL_EMAIL: voce e PDF allegato dalla risposta Unpaywall registrata", async () => {
    const work = corpusWork("peroni2023a");
    const out = await h.call("add_items_by_doi", { dois: [work.sources.doi] });
    expect(out.isError, out.text).toBe(false);
    expect(JSON.stringify(out.json)).toContain('"status":"attached"');
    expect(h.net.requests("PUT", FULLTEXT_ROUTE).map((r) => r.json<{ content: string }>().content).join()).toMatch(TEXT.peroni2023a);
    expect(h.net.unmatched).toEqual([]);
  });
});
