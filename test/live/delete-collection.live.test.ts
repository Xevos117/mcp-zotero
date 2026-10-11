import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { live, startLive, LiveServer, createCollection, createItems, title, rawItem, web, FAKE_KEY } from "./helpers/live.js";

describe.skipIf(!live.enabled)("delete_collection (live)", () => {
  let none: LiveServer;
  let items: LiveServer;
  let target: string;
  beforeAll(async () => {
    none = await startLive({ unsafe: "none" });
    items = await startLive({ unsafe: "items" });
    target = await createCollection("DC target");
  });
  afterAll(async () => {
    await none?.close();
    await items?.close();
  });

  it("LIVE-DC-01 UNSAFE none o items → rifiutato, la collezione resta", async () => {
    for (const s of [none, items]) {
      const r = await s.call("delete_collection", { collection_key: target });
      expect(r.isError).toBe(true);
      expect(r.text).toMatch(/not allowed/);
    }
    expect((await web().get(`collections/${target}`)).status).toBe(200);
  });

  // UNSAFE_OPERATIONS=all non è ammesso in safe mode (libreria personale): questi casi girano solo
  // sull'account dedicato.
  describe.skipIf(live.safeMode)("UNSAFE_OPERATIONS=all", () => {
    let all: LiveServer;
    let withItem: string;
    let item: string;
    beforeAll(async () => {
      all = await startLive({ unsafe: "all" });
      withItem = await createCollection("DC with item");
      [item] = await createItems([{ itemType: "book", title: title("DC item survives"), collections: [withItem] }]);
    });
    afterAll(async () => {
      await all?.close();
    });

    it("LIVE-DC-02 collezione con una voce → cancellata, la voce resta senza quella collezione", async () => {
      const r = await all.call("delete_collection", { collection_key: withItem });
      expect(r.isError, r.text).toBe(false);
      expect(r.json).toEqual({ deleted: true, collection_key: withItem, name: title("DC with item") });
      expect((await web().get(`collections/${withItem}`)).status).toBe(404);
      const after = await rawItem(item);
      expect(after).not.toBeNull();
      expect(after!.collections).not.toContain(withItem);
    });

    it("LIVE-DC-03 chiave sconosciuta → errore; chiave vuota → errore di validazione", async () => {
      expect((await all.call("delete_collection", { collection_key: FAKE_KEY })).isError).toBe(true);
      expect((await all.call("delete_collection", { collection_key: "" })).text).toMatch(/collection_key/);
    });
  });
});
