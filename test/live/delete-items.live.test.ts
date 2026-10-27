import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { live, startLive, LiveServer, createItems, title, rawItem, web, FAKE_KEY } from "./helpers/live.js";

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

  it("LIVE-DI-02 UNSAFE=items, permanent: 30 voci proprie → cancellate definitivamente (non nel cestino)", async () => {
    const keys = own.slice(0, 30);
    const r = await items.call("delete_items", { item_keys: keys, permanent: true });
    expect(r.isError, r.text).toBe(false);
    expect(r.json).toMatchObject({ deleted_count: 30, mode: "permanent" });
    expect(r.json.not_found).toBeUndefined();
    expect(await existing(keys)).toBe(0);
    const trash = (await web().getOk<any[]>(`items/trash?itemKey=${keys.join(",")}&limit=50`)).data;
    expect(trash).toEqual([]);
  });

  it("LIVE-DI-02b default: nel cestino, poi permanente → non resta nulla", async () => {
    const key = own[32];
    const t = await items.call("delete_items", { item_keys: [key] });
    expect(t.isError, t.text).toBe(false);
    expect(t.json).toMatchObject({ deleted_count: 1, mode: "trash" });
    // sparita dalle liste normali, ma recuperabile dal cestino con deleted:1
    expect(await existing([key])).toBe(0);
    expect((await rawItem(key))?.deleted).toBe(1);
    const inTrash = (await web().getOk<any[]>(`items/trash?itemKey=${key}&limit=50`)).data.map((x) => x.key);
    expect(inTrash).toContain(key);
    // ora permanente sulla stessa chiave già nel cestino → via anche dal cestino
    const p = await items.call("delete_items", { item_keys: [key], permanent: true });
    expect(p.isError, p.text).toBe(false);
    expect(p.json).toMatchObject({ deleted_count: 1, mode: "permanent" });
    expect(await rawItem(key)).toBeNull();
    expect((await web().getOk<any[]>(`items/trash?itemKey=${key}&limit=50`)).data).toEqual([]);
  });

  // Ex riga segnata OK a mano (LIVE-STALE-1): il messaggio è "No items found for the given keys" con
  // status "not_found"; la vecchia regex /not found/ non poteva combaciare con "No items found".
  it("LIVE-DI-03 solo chiavi sconosciute → isError, status not_found", async () => {
    const r = await items.call("delete_items", { item_keys: [FAKE_KEY] });
    expect(r.isError).toBe(true);
    expect(r.json).toMatchObject({ error: "No items found for the given keys", status: "not_found", item_keys: [FAKE_KEY] });
  });

  it("LIVE-DI-04 permanent, chiave propria + sconosciuta → 1 cancellata, la sconosciuta in not_found", async () => {
    const r = await items.call("delete_items", { item_keys: [own[30], FAKE_KEY], permanent: true });
    expect(r.json).toMatchObject({ deleted_count: 1, mode: "permanent", not_found: [FAKE_KEY] });
    expect(await rawItem(own[30])).toBeNull();
  });

  it("LIVE-DI-05 51 chiavi o nessuna → errore di validazione, niente cancellato", async () => {
    expect((await items.call("delete_items", { item_keys: Array.from({ length: 51 }, (_, i) => `ZZZZZ0${String(i).padStart(2, "0")}`) })).text).toMatch(/item_keys/);
    expect((await items.call("delete_items", { item_keys: [] })).text).toMatch(/item_keys/);
  });

  it("LIVE-DI-06 permanent, genitore con allegato figlio → cancellati entrambi", async () => {
    const r = await items.call("delete_items", { item_keys: [parent], permanent: true });
    expect(r.isError, r.text).toBe(false);
    expect(r.json, r.text).toMatchObject({ deleted_count: 1, mode: "permanent" });
    expect(await rawItem(parent), r.text).toBeNull();
    expect(await rawItem(child), r.text).toBeNull();
  });

  // Regressione del bug di perdita dati (corretto nella 2.0.1): con sole chiavi malformate la Web API ignora il
  // filtro itemKey e restituisce la libreria intera. Solo sull'account dedicato: se il bug tornasse, in una
  // libreria personale cancellerebbe voci vere.
  it.skipIf(live.safeMode)("LIVE-DI-08 chiavi malformate (minuscole, con 0, traversal) → errore di validazione, nessuna cancellazione", async () => {
    const before = await web().totalResults("items");
    const r = await items.call("delete_items", { item_keys: ["zzzzzzzz", "ZZZZZZZ0", "../tags?tag=x&"] });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/item_keys/);
    expect(await web().totalResults("items")).toBe(before);
  });

  it("LIVE-DI-07 override library_type user", async () => {
    const r = await items.call("delete_items", { item_keys: [own[31]], library_type: "user" });
    expect(r.json.deleted_count).toBe(1);
  });

  const inTrash = async (key: string) => ((await rawItem(key)) ?? {}).deleted === 1;

  it("LIVE-DI-09 cestino di un genitore con figlio: genitore nel cestino, figlio NON cestinato (come il client Zotero)", async () => {
    const [p] = await createItems([{ itemType: "journalArticle", title: title("DI trash parent") }]);
    const [c] = await createItems([
      { itemType: "attachment", parentItem: p, linkMode: "linked_url", title: title("DI trash child"), url: "https://example.org/mzt-di-trash" },
    ]);
    const r = await items.call("delete_items", { item_keys: [p] });
    expect(r.isError, r.text).toBe(false);
    expect(r.json).toMatchObject({ deleted_count: 1, mode: "trash" });
    expect(await inTrash(p), "il genitore è nel cestino").toBe(true);
    expect(await inTrash(c), "il figlio NON è nel cestino (resta, come nel client)").toBe(false);
    // permanente sul genitore → anche il figlio sparisce (cascata server)
    const perm = await items.call("delete_items", { item_keys: [p], permanent: true });
    expect(perm.json).toMatchObject({ deleted_count: 1, mode: "permanent" });
    expect(await rawItem(p)).toBeNull();
    expect(await rawItem(c)).toBeNull();
  });

  it("LIVE-DI-10 voce già nel cestino + default → already_in_trash, deleted_count 0, resta nel cestino", async () => {
    const [k] = await createItems([{ itemType: "book", title: title("DI already trash") }]);
    expect((await items.call("delete_items", { item_keys: [k] })).json).toMatchObject({ deleted_count: 1, mode: "trash" });
    expect(await inTrash(k)).toBe(true);
    const again = await items.call("delete_items", { item_keys: [k] });
    expect(again.isError, again.text).toBe(false);
    expect(again.json).toMatchObject({ deleted_count: 0, mode: "trash", already_in_trash: [k] });
    expect(again.json.hint).toMatch(/permanent: true/);
    expect(await inTrash(k)).toBe(true);
    // permanent:true la rimuove dal cestino
    expect((await items.call("delete_items", { item_keys: [k], permanent: true })).json).toMatchObject({ deleted_count: 1, mode: "permanent" });
    expect(await rawItem(k)).toBeNull();
  });
});
