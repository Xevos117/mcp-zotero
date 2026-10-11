import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFile } from "node:fs/promises";
import { live, startLive, LiveServer, title } from "./helpers/live.js";
import { expectUrisResolve } from "./helpers/docx.js";
import { makeDocx, para, zcite, tempDir, TempDir } from "../helpers/fixtures.js";
import { expectValidDocx } from "../helpers/docx-validate.js";

/**
 * Scritture reali in una libreria di gruppo, solo con ZOTERO_TEST_GROUP_ID impostato e un gruppo il cui
 * nome inizia con "mzt-test" (verificato in global setup; mai in safe mode). Due modi di arrivare al gruppo:
 * per singola chiamata (library_type/library_id) e con il server configurato in modalità gruppo
 * dall'ambiente (ZOTERO_LIBRARY_TYPE=group, ZOTERO_LIBRARY_ID). get_user_id descrive sempre la libreria
 * dell'ambiente (non accetta argomenti), quindi si verifica sul server in modalità gruppo. Il teardown pulisce
 * anche il gruppo.
 */
describe.skipIf(!live.enabled || !live.groupId)("librerie di gruppo (live)", () => {
  let s: LiveServer;
  /** server configurato in modalità gruppo dall'ambiente */
  let g: LiveServer;
  let dir: TempDir;
  let groupCollection: string;
  let groupItem: string;
  const group = () => ({ library_type: "group", library_id: live.groupId! });
  beforeAll(async () => {
    s = await startLive();
    g = await startLive({ env: { ZOTERO_LIBRARY_TYPE: "group", ZOTERO_LIBRARY_ID: live.groupId! } });
    dir = await tempDir();
  });
  afterAll(async () => {
    await s?.close();
    await g?.close();
    await dir?.cleanup();
  });

  it("LIVE-GRP-01 server in modalità gruppo dall'ambiente: get_user_id → libreria del gruppo, user_id dell'utente", async () => {
    const r = await g.call("get_user_id", {});
    expect(r.isError, r.text).toBe(false);
    expect(r.json).toEqual({ user_id: live.userId, library_type: "group", library_id: live.groupId, library_path: `groups/${live.groupId}` });
  });

  it("LIVE-GRP-02 create_collection + add_items nel gruppo → visibili nel gruppo, non nella libreria utente", async () => {
    const c = await s.call("create_collection", { name: title("group collection"), ...group() });
    expect(c.isError, c.text).toBe(false);
    const a = await s.call("add_items", { items: [{ itemType: "book", title: title("group book"), creators: [{ firstName: "Gia", lastName: "Gruppo" }], date: "2021" }], collection_key: c.json.collection_key, tags: [live.runTag], ...group() });
    expect(a.isError, a.text).toBe(false);
    const key = a.json.success[0].item_key;
    groupCollection = c.json.collection_key;
    groupItem = key;
    const inGroup = await s.call("get_collection_items", { collectionKey: c.json.collection_key, ...group() });
    expect(inGroup.json.items.map((i: { key: string }) => i.key)).toEqual([key]);
    expect((await s.call("get_items_details", { item_keys: [key] })).json.message).toBe("No items found for the given keys");

    const input = await dir.file("group.docx", await makeDocx(para(zcite({ keys: key }))));
    const inj = await s.call("inject_citations", { file_path: input, ...group() });
    const report = await expectValidDocx(await readFile(inj.json.output_path), { libraryPath: `groups/${live.groupId}` });
    await expectUrisResolve(report);
  });

  it("LIVE-GRP-03 server in modalità gruppo dall'ambiente, senza argomenti di libreria: legge la collezione e la voce del gruppo", async () => {
    expect(groupCollection, "LIVE-GRP-02 deve essere passato").toBeTruthy();
    const colls = await g.call("get_collections", {});
    expect(colls.isError, colls.text).toBe(false);
    expect(colls.json.some((c: { key: string }) => c.key === groupCollection)).toBe(true);
    const items = await g.call("get_collection_items", { collectionKey: groupCollection });
    expect(items.json.items.map((i: { key: string }) => i.key)).toEqual([groupItem]);
    // l'override per chiamata verso la libreria utente funziona anche da un server di gruppo
    const user = await g.call("get_items_details", { item_keys: [groupItem], library_type: "user" });
    expect(user.json.message).toBe("No items found for the given keys");
  });
});
