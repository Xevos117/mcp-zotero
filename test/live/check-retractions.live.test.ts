import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { live, startLive, LiveServer, trackItems, soft } from "./helpers/live.js";

// DOIs verified by hand on the real Crossref API (api.crossref.org/works/{doi}, updated-by):
// Wakefield et al. 1998 (The Lancet), retracted in 2010 — updated-by [correction, retraction].
const RETRACTED_DOI = "10.1016/S0140-6736(97)11096-0";
// A PLOS ONE article with a correction only (no retraction/EoC) — updated-by [correction].
const CORRECTED_DOI = "10.1371/journal.pone.0161231";
// A real, non-retracted, non-corrected open-access article (PLOS) — no updated-by.
const NORMAL_DOI = "10.1371/journal.pcbi.1004668";

describe.skipIf(!live.enabled)("check_retractions (live)", () => {
  let s: LiveServer;
  beforeAll(async () => {
    s = await startLive();
  });
  afterAll(async () => {
    await s?.close();
  });

  const keysOf = (r: { json: any }) => (r.json?.success ?? []).map((x: { item_key: string }) => x.item_key);

  it("LIVE-CR-01 ritirato → retracted; corretto → corrected; normale → ok; senza DOI → no_doi (Crossref reale)", async (ctx) => {
    // Items created only with the run markers (mzt- title prefix, run tag, run collection) and tracked for teardown
    const add = await s.call("add_items", {
      items: [
        { itemType: "journalArticle", title: "mzt-retracted-check", DOI: RETRACTED_DOI, creators: [{ creatorType: "author", firstName: "A. J.", lastName: "Wakefield" }] },
        { itemType: "journalArticle", title: "mzt-corrected-check", DOI: CORRECTED_DOI, creators: [{ creatorType: "author", firstName: "J", lastName: "Roe" }] },
        { itemType: "journalArticle", title: "mzt-normal-check", DOI: NORMAL_DOI, creators: [{ creatorType: "author", firstName: "J", lastName: "Doe" }] },
        { itemType: "book", title: "mzt-nodoi-check", creators: [{ name: "ACME" }] },
      ],
      tags: [live.runTag],
      collection_key: live.collection,
    });
    trackItems(...keysOf(add));
    expect(add.isError, add.text).toBe(false);
    const keys = keysOf(add);
    expect(keys).toHaveLength(4);

    await soft(ctx, "api.crossref.org", async () => {
      const r = await s.call("check_retractions", { item_keys: keys });
      expect(r.isError, r.text).toBe(false);
      const statusByTitle: Record<string, string> = {};
      for (const it of r.json.items) statusByTitle[it.title] = it.status;
      expect(statusByTitle["mzt-retracted-check"]).toBe("retracted");
      expect(statusByTitle["mzt-corrected-check"]).toBe("corrected");
      expect(statusByTitle["mzt-nodoi-check"]).toBe("no_doi");
      // the "normal" DOI is clean today; if a correction is ever issued it becomes `corrected` — either is fine, as
      // long as it is not flagged (not retracted / expression_of_concern)
      expect(["ok", "corrected"]).toContain(statusByTitle["mzt-normal-check"]);
      const normal = r.json.items.find((i: { title: string }) => i.title === "mzt-normal-check");
      expect(["retracted", "expression_of_concern"]).not.toContain(normal.status);
      expect(r.json.summary.checked).toBe(4);
      expect(r.json.flagged_count).toBe(1); // only the retracted one is flagged; a correction is not
      const retracted = r.json.items.find((i: { status: string }) => i.status === "retracted");
      expect(retracted.notices.some((n: { type: string }) => n.type === "retraction")).toBe(true);
    });
  });

  it("LIVE-CR-02 per collezione: gli stessi item via collection_key", async (ctx) => {
    await soft(ctx, "api.crossref.org", async () => {
      const r = await s.call("check_retractions", { collection_key: live.collection });
      expect(r.isError, r.text).toBe(false);
      // the run collection holds at least the three items added above
      expect(r.json.summary.checked).toBeGreaterThanOrEqual(3);
      expect(r.json.items.some((i: { status: string }) => i.status === "retracted")).toBe(true);
    });
  });
});
