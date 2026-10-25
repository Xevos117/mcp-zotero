import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { live, startLive, LiveServer, createItems, title, trackItems, rawItem, rawChildren, FAKE_KEY } from "./helpers/live.js";

describe.skipIf(!live.enabled)("create_note (live)", () => {
  let s: LiveServer;
  let parent: string;
  let attachment: string;
  beforeAll(async () => {
    s = await startLive();
    [parent, attachment] = await createItems([
      { itemType: "journalArticle", title: title("CN parent") },
      { itemType: "attachment", linkMode: "linked_url", title: title("CN attachment"), url: "https://example.org/mzt-cn" },
    ]);
  });
  afterAll(async () => {
    await s?.close();
  });

  it("LIVE-CN-01 nota figlia in testo semplice → paragrafi e <br/>, salvata sotto il genitore con il tag della run", async () => {
    const r = await s.call("create_note", {
      parent_item_key: parent,
      note: "Primo paragrafo & <nota>\nseconda riga\n\nSecondo paragrafo",
      tags: [live.runTag],
    });
    trackItems(r.json?.item_key);
    expect(r.isError).toBe(false);
    expect(r.json).toMatchObject({ parent_item_key: parent });
    const raw = await rawItem(r.json.item_key);
    expect(raw).toMatchObject({ itemType: "note", parentItem: parent });
    expect(raw!.note).toBe("<p>Primo paragrafo &amp; &lt;nota&gt;<br/>seconda riga</p><p>Secondo paragrafo</p>");
    expect(raw!.tags.map((t: { tag: string }) => t.tag)).toContain(live.runTag);
    const children = await rawChildren(parent);
    expect(children.some((c) => c.key === r.json.item_key && c.itemType === "note")).toBe(true);
  });

  it("LIVE-CN-02 override library_id = proprio id", async () => {
    const r = await s.call("create_note", { parent_item_key: parent, note: "Nota override", tags: [live.runTag], library_id: live.userId });
    trackItems(r.json?.item_key);
    expect(r.isError).toBe(false);
  });

  it("LIVE-CN-03 genitore inesistente → isError leggibile; nota vuota → validazione; genitore allegato → errore", async () => {
    const orphan = await s.call("create_note", { parent_item_key: FAKE_KEY, note: "x", tags: [live.runTag] });
    expect(orphan.isError).toBe(true);
    expect(orphan.text).toMatch(/not found/);
    expect(orphan.text).not.toMatch(/\[object Object\]/);

    expect((await s.call("create_note", { parent_item_key: parent, note: "" })).text).toMatch(/note/);

    const onAttachment = await s.call("create_note", { parent_item_key: attachment, note: "x", tags: [live.runTag] });
    expect(onAttachment.isError).toBe(true);
    expect(onAttachment.text).toMatch(/regular item/);
  });
});
