import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { live, startLive, LiveServer, createItems, title, trackItems } from "./helpers/live.js";
import { FIXTURE_PDF_TEXT } from "./helpers/fixture-server.js";

describe.skipIf(!live.enabled)("get_item_fulltext (live)", () => {
  let s: LiveServer;
  let parent: string;
  let attachment: string;
  let linkedOnly: string;
  beforeAll(async () => {
    s = await startLive();
    [parent, linkedOnly] = await createItems([
      { itemType: "journalArticle", title: title("Fulltext parent") },
      { itemType: "journalArticle", title: title("Parent with linked PDF only") },
    ]);
    const imported = await s.call("import_pdf_to_zotero", { url: `${live.fixtureBase}/paper.pdf`, parent_item: parent, filename: "mzt-fulltext.pdf" });
    if (imported.isError) throw new Error(`import_pdf_to_zotero in setup: ${imported.text}`);
    attachment = imported.json.item_key;
    trackItems(attachment);
    await createItems([
      { itemType: "attachment", parentItem: linkedOnly, linkMode: "linked_url", title: title("Linked PDF"), url: "https://example.org/mzt-linked.pdf", contentType: "application/pdf" },
    ]);
  });
  afterAll(async () => {
    await s?.close();
  });

  it("LIVE-GIF-01 voce con PDF importato → testo estratto e indicizzato su Zotero", async () => {
    const r = await s.call("get_item_fulltext", { item_key: parent });
    expect(r.isError).toBe(false);
    expect(r.json.attachment_key).toBe(attachment);
    expect(r.json.text).toContain(FIXTURE_PDF_TEXT);
  });

  it("LIVE-GIF-02 max_characters 10 → testo troncato", async () => {
    const r = await s.call("get_item_fulltext", { item_key: parent, max_characters: 10 });
    expect(r.json.text.length).toBeLessThanOrEqual(10);
    expect(r.json.truncated).toBe(true);
  });

  it("LIVE-GIF-03 chiave dell'allegato PDF direttamente → stesso testo", async () => {
    const r = await s.call("get_item_fulltext", { item_key: attachment });
    expect(r.json.text).toContain(FIXTURE_PDF_TEXT);
  });

  it("LIVE-GIF-04 webpage senza allegati → guida a usare l'URL", async () => {
    const r = await s.call("get_item_fulltext", { item_key: live.fixtures.webpage });
    expect(r.isError).toBe(true);
    expect(r.json).toMatchObject({ error: "This is a web page item. Use the item's URL to fetch its content directly.", url: "https://example.org/mzt-page" });
  });

  it("LIVE-GIF-05 articolo con URL e senza allegati → nessun PDF, guida all'URL", async () => {
    const r = await s.call("get_item_fulltext", { item_key: live.fixtures.article });
    expect(r.isError).toBe(true);
    expect(r.json.error).toMatch(/^No PDF attachment found\. This item has a URL/);
    expect(r.json.url).toBe("https://example.org/mzt-article");
  });

  it("LIVE-GIF-06 voce senza URL né allegati → nessun PDF", async () => {
    const r = await s.call("get_item_fulltext", { item_key: live.fixtures.noAuthor });
    expect(r.json.error).toBe("No PDF attachment found for this item.");
  });

  it("LIVE-GIF-07 chiave inesistente → Item not found; max_characters non numerico → errore", async () => {
    expect((await s.call("get_item_fulltext", { item_key: "ZZZZZZZZ" })).json?.error).toBe("Item not found");
    expect((await s.call("get_item_fulltext", { item_key: parent, max_characters: "x" })).text).toMatch(/max_characters/);
  });

  // Ex riga segnata OK a mano nel collaudo 2.0.0 (vedi TEST_CASES.md, LIVE-STALE-3): un allegato linked_url
  // con contentType application/pdf viene scelto come PDF; il fulltext di un link non esiste mai sul server,
  // quindi l'utente riceve "Open the PDF in Zotero desktop to trigger indexing", che non può funzionare.
  it.fails("LIVE-GIF-08 solo un link a un PDF (linked_url) → guida al link, non 'apri il PDF in Zotero'", async () => {
    const r = await s.call("get_item_fulltext", { item_key: linkedOnly });
    expect(r.isError).toBe(true);
    expect(r.text).not.toMatch(/Open the PDF in Zotero desktop/);
    expect(r.text).toMatch(/linked|URL/i);
  });
});
