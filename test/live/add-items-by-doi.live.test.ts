import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { live, startLive, LiveServer, trackItems, rawItem, rawChildren, soft, assertNotExternal, probe } from "./helpers/live.js";
import { unpaywallEmail } from "./helpers/env.js";

// DOI reali e stabili (PLOS, CC BY): la risoluzione passa da doi.org/Crossref, quindi i casi sono `soft`.
const DOI_METADATA = "10.1371/journal.pcbi.1004668";
const DOI_SECOND = "10.1371/journal.pbio.1002106";
const DOI_BAD = "10.0000/mzt-does-not-exist-live";

describe.skipIf(!live.enabled)("add_items_by_doi (live)", () => {
  let s: LiveServer;
  beforeAll(async () => {
    s = await startLive();
  });
  afterAll(async () => {
    await s?.close();
  });

  const keysOf = (r: { json: any }) => (r.json?.success ?? []).map((x: { item_key: string }) => x.item_key);

  it("LIVE-AID-01 DOI senza PDF → voce con metadati Crossref, collezione e tag della run", async (ctx) => {
    await soft(ctx, "doi.org", async () => {
      const r = await s.call("add_items_by_doi", { dois: [DOI_METADATA], collection_key: live.collection, tags: [live.runTag], auto_attach_pdf: false });
      trackItems(...keysOf(r));
      assertNotExternal(r, "doi.org");
      expect(r.isError, r.text).toBe(false);
      expect(r.json.success).toHaveLength(1);
      expect(r.json.failed).toEqual([]);
      expect(r.json.pdf_results).toBeUndefined();
      const item = await rawItem(r.json.success[0].item_key);
      expect(item).toMatchObject({ itemType: "journalArticle", DOI: DOI_METADATA, collections: [live.collection] });
      expect(item!.tags.map((t: { tag: string }) => t.tag)).toContain(live.runTag);
      expect(item!.creators.length).toBeGreaterThan(0);
      expect(await rawChildren(r.json.success[0].item_key)).toEqual([]);
    });
  });

  it("LIVE-AID-02 solo DOI inesistente → isError con il DOI tra i falliti, nessuna voce", async (ctx) => {
    await soft(ctx, "doi.org", async () => {
      const r = await s.call("add_items_by_doi", { dois: [DOI_BAD], collection_key: live.collection, tags: [live.runTag] });
      trackItems(...keysOf(r));
      assertNotExternal(r, "doi.org");
      expect(r.isError).toBe(true);
      expect(r.json.error).toBe("All DOI resolutions failed");
      expect(r.json.failed.map((f: { doi: string }) => f.doi)).toEqual([DOI_BAD]);
    });
  });

  it("LIVE-AID-03 DOI valido + inesistente → successo parziale", async (ctx) => {
    await soft(ctx, "doi.org", async () => {
      const r = await s.call("add_items_by_doi", { dois: [DOI_SECOND, DOI_BAD], collection_key: live.collection, tags: [live.runTag], auto_attach_pdf: false });
      trackItems(...keysOf(r));
      assertNotExternal(r, "doi.org");
      expect(r.isError).toBe(false);
      expect(r.json.success.map((x: { doi: string }) => x.doi)).toEqual([DOI_SECOND]);
      expect(r.json.failed.map((x: { doi: string }) => x.doi)).toEqual([DOI_BAD]);
    });
  });

  it("LIVE-AID-04 DOI in forma URL https://doi.org/… → risolto (doi.org normalizza), campo DOI senza prefisso", async (ctx) => {
    await soft(ctx, "doi.org", async () => {
      const r = await s.call("add_items_by_doi", { dois: [`https://doi.org/${DOI_SECOND}`], collection_key: live.collection, tags: [live.runTag], auto_attach_pdf: false });
      trackItems(...keysOf(r));
      assertNotExternal(r, "doi.org");
      expect(r.isError, r.text).toBe(false);
      expect(r.json.success).toHaveLength(1);
      expect((await rawItem(r.json.success[0].item_key))!.DOI).toBe(DOI_SECOND);
    });
  });

  it("LIVE-AID-05 DOI open access con auto_attach_pdf → PDF allegato e indicizzato", async (ctx) => {
    if (!live.oaDoi) ctx.skip(`nessun DOI OA verificato in setup: ${live.oaSkipReason}`);
    await soft(ctx, "doi.org/Unpaywall/editore", async () => {
      await probe(`https://api.unpaywall.org/v2/${encodeURIComponent(live.oaDoi!)}?email=${encodeURIComponent(unpaywallEmail ?? "")}`, "Unpaywall");
      const r = await s.call("add_items_by_doi", { dois: [live.oaDoi!], collection_key: live.collection, tags: [live.runTag] });
      const key = keysOf(r)[0];
      trackItems(key);
      if (key) trackItems(...(await rawChildren(key)).map((c) => c.key));
      assertNotExternal(r, "doi.org/Unpaywall/editore");
      expect(r.isError, r.text).toBe(false);
      expect(r.json.pdf_results).toEqual([expect.objectContaining({ doi: live.oaDoi, pdf_attached: true })]);
      const pdfs = (await rawChildren(key)).filter((c) => c.contentType === "application/pdf" && c.linkMode === "imported_url");
      expect(pdfs).toHaveLength(1);
    });
  });

  it("LIVE-AID-06 dois vuoto → errore", async () => {
    const r = await s.call("add_items_by_doi", { dois: [] });
    expect(r.isError).toBe(true);
  });
});
