import { describe, it, expect } from "vitest";
import { z } from "zod";
import { toolConfig } from "./find-duplicates.js";
import { handleToolCall } from "./index.js";
import { normalizeDoi } from "../utils/doi.js";
import { ZoteroApiInterface, ZoteroItemData } from "../types/zotero-types.js";

const USER_ID = "12345";
const FindDuplicatesSchema = z.object(toolConfig.inputSchema);

/**
 * A chainable Zotero API fake that paginates a fixed item list (100 per page) and records the method
 * chain, so a test can assert that the scan goes through `.top()` (and `.collections()` with a key).
 */
function fakeApi(items: ZoteroItemData[]) {
  const path: string[] = [];
  const pages: number[] = [];
  const api: Partial<ZoteroApiInterface> = {
    library(type: string, id: number | string) {
      path.push(`library:${type}:${id}`);
      return api as ZoteroApiInterface;
    },
    collections(key?: string) {
      path.push(`collections:${key}`);
      return api as ZoteroApiInterface;
    },
    items() {
      path.push("items");
      return api as ZoteroApiInterface;
    },
    top() {
      path.push("top");
      return api as ZoteroApiInterface;
    },
    get(params?: Record<string, unknown>) {
      const start = Number(params?.start ?? 0);
      const limit = Number(params?.limit ?? 100);
      pages.push(start);
      const page = items.slice(start, start + limit);
      return Promise.resolve({
        getData: () => page,
        getVersion: () => 1,
        getTotalResults: () => items.length,
      });
    },
  };
  return { api: api as ZoteroApiInterface, path, pages };
}

async function run(items: ZoteroItemData[], args: Record<string, unknown> = {}) {
  const { api, path, pages } = fakeApi(items);
  const result = await handleToolCall("find_duplicates", args, api, USER_ID);
  const json = JSON.parse(result.content[0].text);
  return { result, json, path, pages };
}

const article = (key: string, over: Partial<ZoteroItemData> = {}): ZoteroItemData => ({
  key,
  itemType: "journalArticle",
  title: `Title ${key}`,
  creators: [{ creatorType: "author", firstName: "Ada", lastName: "Lovelace" }],
  date: "2023",
  ...over,
});

describe("FindDuplicatesSchema", () => {
  it("accepts dois (optional) up to 50 and a collection_key", () => {
    expect(FindDuplicatesSchema.parse({ dois: ["10.1000/x"], collection_key: "CPLQQRZZ" })).toMatchObject({
      dois: ["10.1000/x"],
      collection_key: "CPLQQRZZ",
    });
    expect(FindDuplicatesSchema.parse({})).toEqual({});
  });

  it("rejects more than 50 dois and a malformed collection_key", () => {
    expect(() => FindDuplicatesSchema.parse({ dois: Array(51).fill("10.1000/x") })).toThrow(/50/);
    expect(() => FindDuplicatesSchema.parse({ collection_key: "bad" })).toThrow(/Invalid Zotero key/);
  });
});

describe("normalizeDoi", () => {
  it("strips a DOI quoted inline with trailing sentence punctuation", () => {
    // Before the fix the comma stayed ("10.1000/abc,") and never matched a bare "10.1000/abc".
    expect(normalizeDoi("see 10.1000/abc, p.5")).toBe("10.1000/abc");
    expect(normalizeDoi("(10.1000/abc).")).toBe("10.1000/abc");
    expect(normalizeDoi("10.1000/abc")).toBe("10.1000/abc");
  });

  it("keeps balanced parentheses but strips an unbalanced trailing ')'", () => {
    // Real DOIs contain parentheses (the SICI scheme, Elsevier S0140-6736(97)…): a balanced ')' stays.
    expect(normalizeDoi("10.1000/a(b)")).toBe("10.1000/a(b)");
    expect(normalizeDoi("(see 10.1000/abc)")).toBe("10.1000/abc");
    expect(normalizeDoi("(10.1016/S0140-6736(97)11096-0)")).toBe("10.1016/s0140-6736(97)11096-0");
    // Wakefield's retracted Lancet paper, cited inside parentheses with a trailing period
    expect(normalizeDoi("(10.1016/S0140-6736(97)11096-0).")).toBe("10.1016/s0140-6736(97)11096-0");
  });
});

describe("find_duplicates scan mode", () => {
  it("scans the user library through items().top() and reports mode/scanned/truncated", async () => {
    const { json, path } = await run([article("AAAA0001")]);
    expect(path).toEqual([`library:user:${USER_ID}`, "items", "top"]);
    expect(json).toMatchObject({ mode: "scan", scanned: 1, truncated: false, duplicate_groups: 0, groups: [] });
  });

  it("limits the scan to a collection when collection_key is given", async () => {
    const { path } = await run([article("AAAA0001")], { collection_key: "CPLQQRZZ" });
    expect(path).toEqual([`library:user:${USER_ID}`, "collections:CPLQQRZZ", "items", "top"]);
  });

  it("returns a specific not_found error when the collection does not exist (404)", async () => {
    const err = Object.assign(new Error("404"), { response: { status: 404 } });
    const api = {
      library: () => api,
      collections: () => api,
      items: () => api,
      top: () => api,
      get: () => Promise.reject(err),
    } as unknown as ZoteroApiInterface;
    const result = await handleToolCall("find_duplicates", { collection_key: "CPLQQRZZ" }, api, USER_ID);
    expect(result.isError).toBe(true);
    const json = JSON.parse(result.content[0].text);
    expect(json).toMatchObject({ status: "not_found", collection_key: "CPLQQRZZ" });
    expect(json.suggestion).toContain("get_collections");
  });

  it("scans a group library when library_type/library_id are given", async () => {
    const { path, json } = await run([article("AAAA0001")], { library_type: "group", library_id: "777" });
    expect(path).toEqual(["library:group:777", "items", "top"]);
    expect(json.mode).toBe("scan");
  });

  it("does not group near-identical but distinct titles (Part I vs Part II)", async () => {
    const items = [
      article("PPPP0001", { title: "A Comprehensive Survey of Methods Part I", date: "2020", DOI: "10.1000/p1" }),
      article("PPPP0002", { title: "A Comprehensive Survey of Methods Part II", date: "2020", DOI: "10.1000/p2" }),
    ];
    const { json } = await run(items);
    expect(json.groups).toEqual([]);
  });

  it("treats DOIs that differ only in case or trailing punctuation as the same", async () => {
    const items = [
      article("CCCC0001", { DOI: "10.1234/AbC.2020.XyZ" }),
      article("CCCC0002", { DOI: "https://doi.org/10.1234/abc.2020.xyz." }),
    ];
    const { json } = await run(items);
    expect(json.groups).toHaveLength(1);
    expect(json.groups[0]).toMatchObject({ match: "doi", key: "10.1234/abc.2020.xyz" });
    expect(json.groups[0].items.map((i: { key: string }) => i.key)).toEqual(["CCCC0001", "CCCC0002"]);
  });

  it("with several distinct years under one title, groups only the items that share a year", async () => {
    const title = "A Repeated Long Enough Title";
    const items = [
      article("YYYY0001", { title, date: "2019", DOI: "10.1000/y1" }),
      article("YYYY0002", { title, date: "2019", DOI: "10.1000/y2" }),
      article("YYYY0003", { title, date: "2020", DOI: "10.1000/y3" }),
      article("YYYY0004", { title, date: undefined, DOI: "10.1000/y4" }),
    ];
    const { json } = await run(items);
    expect(json.groups).toHaveLength(1);
    expect(json.groups[0].match).toBe("title");
    expect(json.groups[0].items.map((i: { key: string }) => i.key)).toEqual(["YYYY0001", "YYYY0002"]);
  });

  it("groups by normalized DOI, including a DOI in a URL form and one from the Extra field", async () => {
    const items = [
      article("AAAA0001", { DOI: "10.5555/dup" }),
      article("AAAA0002", { DOI: "https://doi.org/10.5555/DUP" }),
      article("AAAA0003", { DOI: undefined, extra: "tt: x\nDOI: 10.5555/dup\nfoo: bar" }),
      article("AAAA0004", { DOI: "10.5555/other" }),
    ];
    const { json } = await run(items);
    expect(json.groups).toHaveLength(1);
    expect(json.groups[0]).toMatchObject({ match: "doi", key: "10.5555/dup" });
    expect(json.groups[0].items.map((i: { key: string }) => i.key)).toEqual(["AAAA0001", "AAAA0002", "AAAA0003"]);
  });

  it("groups by normalized title ignoring case, accents and punctuation when the year matches", async () => {
    const items = [
      article("TTTT0001", { title: "A Study of Café Métabolisme!", date: "2021-03-02", DOI: "10.1000/a" }),
      article("TTTT0002", { title: "a study of cafe   metabolisme", date: "2021", DOI: "10.1000/b" }),
    ];
    const { json } = await run(items);
    expect(json.groups).toHaveLength(1);
    expect(json.groups[0]).toMatchObject({ match: "title", key: "a study of cafe metabolisme" });
    expect(json.groups[0].items.map((i: { key: string }) => i.key)).toEqual(["TTTT0001", "TTTT0002"]);
  });

  it("does not group same-title items when both have a year and the years differ", async () => {
    const items = [
      article("TTTT0001", { title: "The Same Long Enough Title", date: "2019", DOI: "10.1000/a" }),
      article("TTTT0002", { title: "the same long enough title", date: "2020", DOI: "10.1000/b" }),
    ];
    const { json } = await run(items);
    expect(json.groups).toEqual([]);
  });

  it("groups same-title items when one has a year and the other has none", async () => {
    const items = [
      article("TTTT0001", { title: "The Same Long Enough Title", date: "2019", DOI: "10.1000/a" }),
      article("TTTT0002", { title: "the same long enough title", date: undefined, DOI: "10.1000/b" }),
    ];
    const { json } = await run(items);
    expect(json.groups).toHaveLength(1);
    expect(json.groups[0].match).toBe("title");
  });

  it("skips very short normalized titles to avoid false positives", async () => {
    const items = [
      article("SSSS0001", { title: "Note", date: "2020", DOI: "10.1000/a" }),
      article("SSSS0002", { title: "note", date: "2020", DOI: "10.1000/b" }),
    ];
    const { json } = await run(items);
    expect(json.groups).toEqual([]);
  });

  it("excludes standalone notes and attachments from the scan", async () => {
    // The trash is excluded by the Web API (`/items/top` drops trashed items by default), which the
    // chainable fake here cannot model; that exclusion is covered live in LIVE-FD-01 (a trashed
    // same-DOI item does not appear). This case only checks the in-code note/attachment filter.
    const items = [
      article("RRRR0001", { title: "A Duplicated Full Title", date: "2020", DOI: "10.1000/a" }),
      article("RRRR0002", { title: "a duplicated full title", date: "2020", DOI: "10.1000/b" }),
      { key: "NOTE0001", itemType: "note", title: "A Duplicated Full Title", date: "2020" },
      { key: "ATTT0001", itemType: "attachment", title: "A Duplicated Full Title", date: "2020" },
    ];
    const { json } = await run(items);
    expect(json.scanned).toBe(2);
    expect(json.groups).toHaveLength(1);
    expect(json.groups[0].items.map((i: { key: string }) => i.key)).toEqual(["RRRR0001", "RRRR0002"]);
  });

  it("groups a DOI field value and a DOI from Extra that differ only by trailing punctuation", async () => {
    const items = [
      article("EEEE0001", { DOI: "10.1000/abc" }),
      article("EEEE0002", { DOI: undefined, extra: "DOI: 10.1000/abc, see note\nfoo: bar" }),
    ];
    const { json } = await run(items);
    expect(json.groups).toHaveLength(1);
    expect(json.groups[0]).toMatchObject({ match: "doi", key: "10.1000/abc" });
  });

  it("groups duplicate CJK titles with the lower CJK length threshold", async () => {
    const items = [
      { key: "HANA0001", itemType: "journalArticle", title: "深度学习", date: "2021", creators: [] },
      { key: "HANA0002", itemType: "journalArticle", title: "深度学习", date: "2021", creators: [] },
    ];
    const { json } = await run(items);
    expect(json.groups).toHaveLength(1);
    expect(json.groups[0]).toMatchObject({ match: "title", key: "深度学习" });
    expect(json.groups[0].items.map((i: { key: string }) => i.key)).toEqual(["HANA0001", "HANA0002"]);
  });

  it("still skips a very short generic CJK title (below the CJK threshold)", async () => {
    const items = [
      { key: "HANB0001", itemType: "journalArticle", title: "序言", date: "2021", creators: [] },
      { key: "HANB0002", itemType: "journalArticle", title: "序言", date: "2021", creators: [] },
    ];
    const { json } = await run(items);
    expect(json.groups).toEqual([]);
  });

  it("groups duplicate Cyrillic titles (Latin threshold, letters preserved)", async () => {
    const items = [
      { key: "CYRA0001", itemType: "journalArticle", title: "Глубокое обучение", date: "2021", creators: [] },
      { key: "CYRA0002", itemType: "journalArticle", title: "глубокое  обучение", date: "2021", creators: [] },
    ];
    const { json } = await run(items);
    expect(json.groups).toHaveLength(1);
    expect(json.groups[0]).toMatchObject({ match: "title", key: "глубокое обучение" });
  });

  it("does not also report title duplicates for items already grouped by DOI", async () => {
    const items = [
      article("DDDD0001", { title: "Identical Long Enough Title", date: "2020", DOI: "10.9000/same" }),
      article("DDDD0002", { title: "identical long enough title", date: "2020", DOI: "10.9000/same" }),
    ];
    const { json } = await run(items);
    expect(json.groups).toHaveLength(1);
    expect(json.groups[0].match).toBe("doi");
  });

  it("walks every page (100 per page) and groups across page boundaries", async () => {
    const filler = Array.from({ length: 150 }, (_, i) => article(`F${String(i).padStart(7, "0")}`, { DOI: `10.2000/${i}`, title: `Unique filler ${i}` }));
    filler[0] = article("P000A", { DOI: "10.3000/cross", title: "Cross page one" });
    filler[120] = article("P120B", { DOI: "10.3000/cross", title: "Cross page two" });
    const { json, pages } = await run(filler);
    expect(pages).toEqual([0, 100]);
    expect(json.scanned).toBe(150);
    const doiGroup = json.groups.find((g: { key: string }) => g.key === "10.3000/cross");
    expect(doiGroup.items.map((i: { key: string }) => i.key)).toEqual(["P000A", "P120B"]);
  });

  it("reports truncated when the scan cap is reached", async () => {
    const many = Array.from({ length: 5050 }, (_, i) => article(`M${String(i).padStart(7, "0")}`, { DOI: `10.4000/${i}`, title: `Row ${i}` }));
    const { json } = await run(many);
    expect(json.scanned).toBe(5000);
    expect(json.truncated).toBe(true);
  });
});

describe("find_duplicates dois mode", () => {
  it("returns, per DOI, the matching items already in the library (URL form normalized)", async () => {
    const items = [
      article("AAAA0001", { DOI: "10.7000/present" }),
      article("AAAA0002", { DOI: "10.7000/other" }),
    ];
    const { json } = await run(items, { dois: ["https://doi.org/10.7000/PRESENT", "10.7000/missing", "not-a-doi"] });
    expect(json.mode).toBe("dois");
    expect(json.dois[0]).toMatchObject({ doi: "https://doi.org/10.7000/PRESENT", normalized: "10.7000/present" });
    expect(json.dois[0].existing.map((e: { key: string }) => e.key)).toEqual(["AAAA0001"]);
    expect(json.dois[1]).toMatchObject({ doi: "10.7000/missing", normalized: "10.7000/missing", existing: [] });
    expect(json.dois[2]).toMatchObject({ doi: "not-a-doi", normalized: null, existing: [] });
  });

  it("handles the same DOI passed twice in the input (different forms), reporting each", async () => {
    const items = [article("AAAA0001", { DOI: "10.1234/same" })];
    const { json } = await run(items, { dois: ["10.1234/same", "https://doi.org/10.1234/SAME"] });
    expect(json.dois).toHaveLength(2);
    expect(json.dois[0]).toMatchObject({ doi: "10.1234/same", normalized: "10.1234/same" });
    expect(json.dois[1]).toMatchObject({ doi: "https://doi.org/10.1234/SAME", normalized: "10.1234/same" });
    expect(json.dois[0].existing.map((e: { key: string }) => e.key)).toEqual(["AAAA0001"]);
    expect(json.dois[1].existing.map((e: { key: string }) => e.key)).toEqual(["AAAA0001"]);
  });

  it("reports every matching item when the same DOI is on several library entries", async () => {
    const items = [
      article("AAAA0001", { DOI: "10.1234/dup" }),
      article("AAAA0002", { DOI: "10.1234/dup" }),
    ];
    const { json } = await run(items, { dois: ["10.1234/dup"] });
    expect(json.dois[0].existing.map((e: { key: string }) => e.key).sort()).toEqual(["AAAA0001", "AAAA0002"]);
  });

  it("carries title, year, first author, type and doi in each returned entry", async () => {
    const items = [article("AAAA0001", { DOI: "10.7000/present", title: "A Paper", date: "2022-05", itemType: "journalArticle" })];
    const { json } = await run(items, { dois: ["10.7000/present"] });
    expect(json.dois[0].existing[0]).toEqual({
      key: "AAAA0001",
      title: "A Paper",
      year: "2022",
      first_author: "Ada Lovelace",
      item_type: "journalArticle",
      doi: "10.7000/present",
    });
  });
});
