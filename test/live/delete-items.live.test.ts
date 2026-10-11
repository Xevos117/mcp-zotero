import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { live, startLive, LiveServer, createItems, title, rawItem, web } from "./helpers/live.js";

describe.skipIf(!live.enabled)("delete_items (live)", () => {
  let none: LiveServer;
  let items: LiveServer;
  let own: string[];
  let parent: string;
  let child: string;
  beforeAll(async () => {
    none = await startLive({ unsafe: "none" });
    items = await startLive({ unsafe: "items" });
    own = await createItems(Array.from({ length: 33 }, (_, i) => ({ itemType: "book", title: title(`DI own ${String(i).padStart(2, "0")}`) })));
    [parent] = await createItems([{ itemType: "journalArticle", title: title("DI parent") }]);
    [child] = await createItems([{ itemType: "attachment", parentItem: parent, linkMode: "linked_url", title: title("DI child link"), url: "https://example.org/mzt-di" }]);
  });
  afterAll(async () => {
    await none?.close();
    await items?.close();
  });

  const existing = async (keys: string[]) => (await web().getOk<any[]>(`items?itemKey=${keys.join(",")}&limit=50`)).data.length;

  it("LIVE-DI-01 UNSAFE_OPERATIONS=none → rifiutato, la voce resta", async () => {
    const r = await none.call("delete_items", { item_keys: [own[0]] });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/not allowed/);
    expect(await rawItem(own[0])).not.toBeNull();
  });

  it("LIVE-DI-02 UNSAFE=items: 30 voci proprie → tutte cancellate definitivamente (non nel cestino)", async () => {
    const keys = own.slice(0, 30);
    const r = await items.call("delete_items", { item_keys: keys });
    expect(r.isError, r.text).toBe(false);
    expect(r.json.deleted_count).toBe(30);
    expect(r.json.not_found).toBeUndefined();
    expect(await existing(keys)).toBe(0);
    const trash = (await web().getOk<any[]>(`items/trash?itemKey=${keys.join(",")}&limit=50`)).data;
    expect(trash).toEqual([]);
  });

  // Ex riga segnata OK a mano (LIVE-STALE-1): il messaggio è "No items found for the given keys" con
  // status "not_found"; la vecchia regex /not found/ non poteva combaciare con "No items found".
  it("LIVE-DI-03 solo chiavi sconosciute → isError, status not_found", async () => {
    const r = await items.call("delete_items", { item_keys: ["ZZZZZZZZ"] });
    expect(r.isError).toBe(true);
    expect(r.json).toMatchObject({ error: "No items found for the given keys", status: "not_found", item_keys: ["ZZZZZZZZ"] });
  });

  it("LIVE-DI-04 chiave propria + sconosciuta → 1 cancellata, la sconosciuta in not_found", async () => {
    const r = await items.call("delete_items", { item_keys: [own[30], "ZZZZZZZZ"] });
    expect(r.json).toMatchObject({ deleted_count: 1, not_found: ["ZZZZZZZZ"] });
    expect(await rawItem(own[30])).toBeNull();
  });

  it("LIVE-DI-05 51 chiavi o nessuna → errore di validazione, niente cancellato", async () => {
    expect((await items.call("delete_items", { item_keys: Array.from({ length: 51 }, (_, i) => `ZZZZZZ${String(i).padStart(2, "0")}`) })).text).toMatch(/item_keys/);
    expect((await items.call("delete_items", { item_keys: [] })).text).toMatch(/item_keys/);
  });

  it("LIVE-DI-06 genitore con allegato figlio → cancellati entrambi", async () => {
    const r = await items.call("delete_items", { item_keys: [parent] });
    expect(r.json.deleted_count).toBe(1);
    expect(await rawItem(parent)).toBeNull();
    expect(await rawItem(child)).toBeNull();
  });

  it("LIVE-DI-07 override library_type user", async () => {
    const r = await items.call("delete_items", { item_keys: [own[31]], library_type: "user" });
    expect(r.json.deleted_count).toBe(1);
  });
});
