import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { live, startLive, LiveServer, createCollection, createItems, title, trackItems, rawChildren, soft } from "./helpers/live.js";

describe.skipIf(!live.enabled)("find_and_attach_pdfs (live)", () => {
  let s: LiveServer;
  let coll: string;
  let noDoi: string;
  let fakeDoi: string;
  let withPdf: string;
  let oaItem: string | undefined;
  /** voci regolari nella collezione (gli allegati standalone non contano) */
  let regularInCollection: number;
  beforeAll(async () => {
    s = await startLive();
    coll = await createCollection("find and attach");
    const objects: Array<Record<string, unknown>> = [
      { itemType: "journalArticle", title: title("FA no DOI"), collections: [coll] },
      { itemType: "journalArticle", title: title("FA fake DOI"), DOI: "10.9999/mzt.fa-not-registered", collections: [coll] },
      { itemType: "journalArticle", title: title("FA already has PDF"), DOI: "10.9999/mzt.fa-has-pdf", collections: [coll] },
      { itemType: "attachment", linkMode: "linked_url", title: title("FA standalone link"), url: "https://example.org/mzt-fa", collections: [coll] },
    ];
    if (live.oaDoi) objects.push({ itemType: "journalArticle", title: title("FA open access"), DOI: live.oaDoi, collections: [coll] });
    [noDoi, fakeDoi, withPdf, , oaItem] = await createItems(objects);
    regularInCollection = objects.filter((o) => o.itemType !== "attachment").length;
    // un PDF già presente (link con contentType PDF: è quello che il controllo "attachment exists" guarda)
    await createItems([{ itemType: "attachment", parentItem: withPdf, linkMode: "linked_url", title: title("FA existing PDF"), url: "https://example.org/mzt-existing.pdf", contentType: "application/pdf" }]);
  });
  afterAll(async () => {
    await s?.close();
  });

  it("LIVE-FA-01 item_keys e collection_key insieme, o nessuno dei due → errore", async () => {
    expect((await s.call("find_and_attach_pdfs", { item_keys: [noDoi], collection_key: coll })).text).toMatch(/either/i);
    expect((await s.call("find_and_attach_pdfs", {})).text).toMatch(/either/i);
  });

  it("LIVE-FA-02 chiave sconosciuta e voce senza DOI → error con il motivo, senza servizi esterni", async () => {
    const r = await s.call("find_and_attach_pdfs", { item_keys: ["ZZZZZZZZ", noDoi], dry_run: true });
    expect(r.json.results).toEqual([
      expect.objectContaining({ item_key: "ZZZZZZZZ", status: "error", reason: "Item not found" }),
      expect.objectContaining({ item_key: noDoi, status: "error", reason: "No DOI" }),
    ]);
  });

  it("LIVE-FA-03 PDF già presente → skipped (default); con skip_if_attachment_exists false passa alla ricerca", async () => {
    const r = await s.call("find_and_attach_pdfs", { item_keys: [withPdf], dry_run: true });
    expect(r.json.results[0]).toMatchObject({ status: "skipped", reason: "PDF attachment already exists" });
    const again = await s.call("find_and_attach_pdfs", { item_keys: [withPdf], dry_run: true, skip_if_attachment_exists: false });
    expect(again.json.results[0].status).not.toBe("skipped");
  });

  // Ex righe segnate OK a mano (LIVE-STALE-2 e 4): processed va confrontato con le voci create dalla run,
  // non con un numero fisso; gli allegati standalone della collezione non vengono processati.
  it("LIVE-FA-04 collezione in dry_run → processed = voci regolari create, un risultato per voce", async (ctx) => {
    await soft(ctx, "Unpaywall", async () => {
      const r = await s.call("find_and_attach_pdfs", { collection_key: coll, dry_run: true });
      expect(r.isError, r.text).toBe(false);
      expect(r.json.dry_run).toBe(true);
      expect(r.json.processed).toBe(regularInCollection);
      expect(r.json.results).toHaveLength(regularInCollection);
      expect(r.json.results.find((x: { item_key: string }) => x.item_key === fakeDoi).status).toBe("not_found");
      if (oaItem) expect(r.json.results.find((x: { item_key: string }) => x.item_key === oaItem).status).toBe("available");
    });
  });

  it("LIVE-FA-05 collezione reale → processed = voci regolari; la voce OA riceve il PDF", async (ctx) => {
    await soft(ctx, "Unpaywall/editore", async () => {
      const r = await s.call("find_and_attach_pdfs", { collection_key: coll });
      if (oaItem) trackItems(...(await rawChildren(oaItem)).map((c) => c.key));
      expect(r.isError, r.text).toBe(false);
      expect(r.json.processed).toBe(regularInCollection);
      expect(r.json.attached + r.json.not_found + r.json.skipped + r.json.errors + r.json.quota_exceeded).toBe(regularInCollection);
      if (oaItem) {
        const pdfs = (await rawChildren(oaItem)).filter((c) => c.contentType === "application/pdf" && c.linkMode === "imported_url");
        expect(pdfs.length).toBeGreaterThanOrEqual(1);
      }
    });
  });

  it("LIVE-FA-06 override library_type user in dry_run", async () => {
    const r = await s.call("find_and_attach_pdfs", { item_keys: [withPdf], dry_run: true, library_type: "user" });
    expect(r.json.results[0].status).toBe("skipped");
  });
});
