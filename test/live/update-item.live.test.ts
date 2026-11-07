import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { live, startLive, LiveServer, createItems, title, rawItem } from "./helpers/live.js";

describe.skipIf(!live.enabled)("update_item (live)", () => {
  let s: LiveServer;
  beforeAll(async () => {
    s = await startLive();
  });
  afterAll(async () => {
    await s?.close();
  });

  /** A fresh run-owned item plus its current version, read through get_items_details. */
  async function freshItem(label: string, extra: Record<string, unknown> = {}): Promise<{ key: string; version: number }> {
    const [key] = await createItems([{ itemType: "journalArticle", title: title(label), ...extra }]);
    const d = await s.call("get_items_details", { item_keys: [key] });
    return { key, version: d.json[key].version };
  }

  it("LIVE-UI-01 campi e creators con la versione corretta → salvati, versione aggiornata", async () => {
    const { key, version } = await freshItem("UI edit");
    const r = await s.call("update_item", {
      item_key: key,
      version,
      fields: { title: title("UI edited"), pages: "11-20", volume: "7" },
      creators: [{ firstName: "Grace", lastName: "Hopper" }, { name: "ACME", creatorType: "contributor" }],
    });
    expect(r.isError).toBe(false);
    expect(r.json).toMatchObject({ item_key: key, creators_replaced: true });
    expect(r.json.version).toBeGreaterThan(version);
    const raw = await rawItem(key);
    expect(raw).toMatchObject({ title: title("UI edited"), pages: "11-20", volume: "7", version: r.json.version });
    expect(raw!.creators).toEqual([
      { firstName: "Grace", lastName: "Hopper", creatorType: "author" },
      { name: "ACME", creatorType: "contributor" },
    ]);
  });

  it("LIVE-UI-02 versione stantia → version_conflict, item invariato", async () => {
    const { key, version } = await freshItem("UI stale");
    // Bump the version with a first update, so the original version is now stale.
    const first = await s.call("update_item", { item_key: key, version, fields: { title: title("UI stale v2") } });
    expect(first.isError).toBe(false);
    const conflict = await s.call("update_item", { item_key: key, version, fields: { title: title("UI should not apply") } });
    expect(conflict.isError).toBe(true);
    expect(conflict.json).toMatchObject({ code: "version_conflict", expected_version: version });
    expect(conflict.json.hint).toMatch(/get_items_details/);
    expect((await rawItem(key))!.title).toBe(title("UI stale v2"));
  });

  it("LIVE-UI-03 title mappato per tipo, campo non valido e campo protetto rifiutati", async () => {
    const [caseKey] = await createItems([{ itemType: "case", caseName: title("UI case") }]);
    const cv = (await s.call("get_items_details", { item_keys: [caseKey] })).json[caseKey].version;
    const r = await s.call("update_item", { item_key: caseKey, version: cv, fields: { title: title("UI case renamed") } });
    expect(r.isError).toBe(false);
    expect((await rawItem(caseKey))!.caseName).toBe(title("UI case renamed"));

    const { key, version } = await freshItem("UI invalid");
    expect((await s.call("update_item", { item_key: key, version, fields: { thisIsNotAField: "x" } })).text).toMatch(/thisIsNotAField/);
    const prot = await s.call("update_item", { item_key: key, version, fields: { itemType: "book" } });
    expect(prot.isError).toBe(true);
    expect(prot.text).toMatch(/cannot be set/);
    // Nothing changed by the rejected calls
    expect((await rawItem(key))!.title).toBe(title("UI invalid"));
  });
});
