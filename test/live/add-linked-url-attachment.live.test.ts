import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { live, startLive, LiveServer, createItems, title, trackItems, rawItem, FAKE_KEY } from "./helpers/live.js";

describe.skipIf(!live.enabled)("add_linked_url_attachment (live)", () => {
  let s: LiveServer;
  let parent: string;
  beforeAll(async () => {
    s = await startLive();
    [parent] = await createItems([{ itemType: "journalArticle", title: title("ALU parent") }]);
  });
  afterAll(async () => {
    await s?.close();
  });

  it("LIVE-ALU-01 figlio con titolo, content_type e tag → linked_url salvato sotto il genitore", async () => {
    const r = await s.call("add_linked_url_attachment", {
      url: "https://example.org/mzt-paper.pdf",
      title: title("ALU linked"),
      content_type: "application/pdf",
      parent_item: parent,
      tags: [live.runTag],
    });
    trackItems(r.json?.item_key);
    expect(r.isError).toBe(false);
    expect(r.json).toMatchObject({ title: title("ALU linked"), parent_item: parent, link_mode: "linked_url", url: "https://example.org/mzt-paper.pdf" });
    expect(await rawItem(r.json.item_key)).toMatchObject({ itemType: "attachment", linkMode: "linked_url", parentItem: parent, contentType: "application/pdf", url: "https://example.org/mzt-paper.pdf" });
  });

  it("LIVE-ALU-02 standalone in due collezioni", async () => {
    const r = await s.call("add_linked_url_attachment", { url: "https://example.org/mzt-standalone", title: title("ALU standalone"), collections: [live.collection, live.subcollection] });
    trackItems(r.json?.item_key);
    expect(r.json.parent_item).toBeNull();
    expect((await rawItem(r.json.item_key))!.collections.sort()).toEqual([live.collection, live.subcollection].sort());
  });

  it("LIVE-ALU-03 override library_id = proprio id", async () => {
    const r = await s.call("add_linked_url_attachment", { url: "https://example.org/mzt-ov", title: title("ALU override"), parent_item: parent, library_id: live.userId });
    trackItems(r.json?.item_key);
    expect(r.isError).toBe(false);
  });

  it("LIVE-ALU-04 URL non valido → errore di validazione; genitore inesistente → isError leggibile", async () => {
    expect((await s.call("add_linked_url_attachment", { url: "not a url" })).text).toMatch(/url/);
    const r = await s.call("add_linked_url_attachment", { url: "https://example.org/x", title: title("ALU orphan"), parent_item: FAKE_KEY });
    trackItems(r.json?.item_key);
    expect(r.isError).toBe(true);
    expect(r.text).not.toMatch(/\[object Object\]/);
  });
});
