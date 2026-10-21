import { describe, it, expect, afterEach } from "vitest";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-expect-error plain .mjs script without type declarations
import { buildLibrary, corpusProblems, loadCorpus, renderLicenses } from "../../scripts/record-corpus.mjs";
import { CORPUS_DIR, corpusLibrary, corpusManifest } from "../helpers/corpus.js";
import { ITEM_TYPE_CREATOR_TYPES, ITEM_TYPE_FIELDS, ZoteroItemType } from "../../src/utils/zotero-item-types.js";

/** The committed corpus is consistent and passes the same checks as scripts/record-corpus.mjs. */

const SENTINEL = "corpus-secret-sentinel-0000";

describe("corpus di fixture (test/fixtures/corpus)", () => {
  const copies: string[] = [];
  afterEach(() => {
    for (const d of copies.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  /** Copy of the corpus in a temp dir, to break it on purpose. */
  function copy(): string {
    const d = mkdtempSync(join(tmpdir(), "mcp-zotero-corpus-"));
    cpSync(CORPUS_DIR, d, { recursive: true });
    copies.push(d);
    return d;
  }

  it("CORPUS-01 i controlli dello script di registrazione passano (licenze, segreti, dimensioni, chiavi, PDF)", () => {
    expect(corpusProblems(CORPUS_DIR, [SENTINEL])).toEqual([]);
  });

  it("CORPUS-02 library.json e LICENSES.md sono quelli che lo script ricostruisce dalle cassette", () => {
    const { manifest, cassettes, overrides } = loadCorpus(CORPUS_DIR);
    const library = buildLibrary(manifest, cassettes, overrides);
    expect(library).toEqual(JSON.parse(readFileSync(join(CORPUS_DIR, "library.json"), "utf8")));
    expect(renderLicenses(manifest, library)).toBe(readFileSync(join(CORPUS_DIR, "LICENSES.md"), "utf8"));
  });

  it("CORPUS-03 le voci curate sono valide per lo schema Zotero (campi e ruoli per tipo)", () => {
    const { items, collections } = corpusLibrary();
    const collectionKeys = new Set(collections.map((c) => c.key));
    expect(items).toHaveLength(corpusManifest().works.length);
    for (const item of items) {
      const type = item.itemType as ZoteroItemType;
      expect(ITEM_TYPE_FIELDS[type], `${item.key} itemType`).toBeDefined();
      const fields = Object.keys(item).filter((f) => !["key", "itemType", "creators", "collections", "tags", "relations"].includes(f));
      expect(fields.filter((f) => !ITEM_TYPE_FIELDS[type].has(f)), `${item.key} fields`).toEqual([]);
      for (const c of item.creators as Array<{ creatorType: string }>) {
        expect(ITEM_TYPE_CREATOR_TYPES[type].has(c.creatorType), `${item.key} ${c.creatorType}`).toBe(true);
      }
      for (const k of item.collections as string[]) expect(collectionKeys.has(k)).toBe(true);
    }
  });

  it("CORPUS-04 i controlli scattano: email, segreto dell'ambiente, ORCID, licenza NC, campo vietato", () => {
    const d = copy();
    const id = corpusManifest().works.find((w) => w.sources.doi)!.id;
    const cassettePath = join(d, "cassettes", `${id}.json`);
    const cassette = JSON.parse(readFileSync(cassettePath, "utf8"));
    cassette[0].request.url += `?email=someone@example.org&x=${SENTINEL}`;
    cassette[0].response.body.note = "0000-0002-1825-0097";
    cassette[0].response.body.license = [{ URL: "https://creativecommons.org/licenses/by-nc/4.0/" }];
    cassette[0].response.body.author = [{ family: "X", affiliation: [] }];
    writeFileSync(cassettePath, JSON.stringify(cassette));
    const problems = corpusProblems(d, [SENTINEL]).join("\n");
    expect(problems).toContain("contains an email address");
    expect(problems).toContain("contains a URL with '@'");
    expect(problems).toContain("contains a value from the environment");
    expect(problems).toContain("contains an ORCID iD");
    expect(problems).toContain("by-nc/4.0/ is not CC BY / CC0");
    expect(problems).toContain("forbidden field");
  });

  it("CORPUS-05 i controlli scattano: PDF modificato, anni diversi nella coppia a/b, chiave non valida", () => {
    const d = copy();
    const manifest = JSON.parse(readFileSync(join(d, "corpus.json"), "utf8"));
    const withPdf = manifest.works.find((w: { pdf: unknown }) => w.pdf);
    writeFileSync(join(d, "pdfs", `${withPdf.id}.pdf`), "%PDF-1.4 changed");
    const pair = manifest.works.find((w: { sameYearAs?: string }) => w.sameYearAs);
    const other = join(d, "cassettes", `${pair.sameYearAs}.json`);
    const cassette = JSON.parse(readFileSync(other, "utf8"));
    cassette[0].response.body.issued = { "date-parts": [[1999]] };
    writeFileSync(other, JSON.stringify(cassette));
    manifest.works[0].key = "AAAA1111";
    writeFileSync(join(d, "corpus.json"), JSON.stringify(manifest));
    const problems = corpusProblems(d, [SENTINEL]).join("\n");
    expect(problems).toContain(`${withPdf.id}: pdf sha256/bytes differ`);
    expect(problems).toContain("pick another pair");
    expect(problems).toContain("AAAA1111 is not a valid Zotero key");
  });
});
