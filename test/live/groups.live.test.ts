import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFile } from "node:fs/promises";
import { live, startLive, LiveServer, title } from "./helpers/live.js";
import { expectUrisResolve } from "./helpers/docx.js";
import { makeDocx, para, zcite, tempDir, TempDir } from "../helpers/fixtures.js";
import { expectValidDocx } from "../helpers/docx-validate.js";

/**
 * Scritture reali in una libreria di gruppo, solo con ZOTERO_TEST_GROUP_ID impostato e un gruppo il cui
 * nome inizia con "mzt-test" (verificato in global setup; mai in safe mode). Il cambio di libreria avviene
 * per singola chiamata (library_type/library_id); il teardown pulisce anche il gruppo.
 */
describe.skipIf(!live.enabled || !live.groupId)("librerie di gruppo (live)", () => {
  let s: LiveServer;
  let dir: TempDir;
  const group = () => ({ library_type: "group", library_id: live.groupId! });
  beforeAll(async () => {
    s = await startLive();
    dir = await tempDir();
  });
  afterAll(async () => {
    await s?.close();
    await dir?.cleanup();
  });

  it("LIVE-GRP-01 get_user_id per chiamata → library_path del gruppo", async () => {
    const r = await s.call("get_user_id", group());
    expect(r.json).toMatchObject({ library_type: "group", library_id: live.groupId, library_path: `groups/${live.groupId}` });
  });

  it("LIVE-GRP-02 create_collection + add_items nel gruppo → visibili nel gruppo, non nella libreria utente", async () => {
    const c = await s.call("create_collection", { name: title("group collection"), ...group() });
    expect(c.isError, c.text).toBe(false);
    const a = await s.call("add_items", { items: [{ itemType: "book", title: title("group book"), creators: [{ firstName: "Gia", lastName: "Gruppo" }], date: "2021" }], collection_key: c.json.collection_key, tags: [live.runTag], ...group() });
    expect(a.isError, a.text).toBe(false);
    const key = a.json.success[0].item_key;
    const inGroup = await s.call("get_collection_items", { collectionKey: c.json.collection_key, ...group() });
    expect(inGroup.json.items.map((i: { key: string }) => i.key)).toEqual([key]);
    expect((await s.call("get_items_details", { item_keys: [key] })).json.message).toBe("No items found for the given keys");

    const input = await dir.file("group.docx", await makeDocx(para(zcite({ keys: key }))));
    const inj = await s.call("inject_citations", { file_path: input, ...group() });
    const report = await expectValidDocx(await readFile(inj.json.output_path), { libraryPath: `groups/${live.groupId}` });
    await expectUrisResolve(report);
  });
});
