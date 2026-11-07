import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  Harness,
  startHarness,
  expectValidationError,
  expectErrorJson,
  expectApiError,
  ZOTERO_ERROR_STATUSES,
} from "../helpers/mcp-harness.js";
import { networkError } from "../helpers/fake-net.js";
import { ZBASE, zSingle, zPatch, zError, article } from "../helpers/zotero-fake.js";

const KEY = "AAAARRRR";
const ITEM_URL = `${ZBASE}/items/${KEY}`;

describe("update_item (MCP)", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await startHarness();
  });
  afterEach(async () => {
    await h.close();
  });

  it("UI-01 version corretta → PATCH con If-Unmodified-Since-Version, nuova versione restituita", async () => {
    h.net.on("GET", ITEM_URL, zSingle(article(KEY), 7));
    h.net.on("PATCH", ITEM_URL, zPatch({ version: 7, newVersion: 8 }));
    const out = await h.call("update_item", { item_key: KEY, version: 7, fields: { title: "Nuovo", pages: "1-9" } });
    expect(out.isError).toBe(false);
    expect(out.json).toMatchObject({ item_key: KEY, version: 8, updated_fields: ["title", "pages"] });
    const patch = h.net.requests("PATCH", ITEM_URL);
    expect(patch).toHaveLength(1);
    expect(patch[0].headers.get("if-unmodified-since-version")).toBe("7");
    expect(patch[0].json()).toEqual({ title: "Nuovo", pages: "1-9" });
  });

  it("UI-02 version non combacia (pre-check) → version_conflict senza PATCH", async () => {
    h.net.on("GET", ITEM_URL, zSingle(article(KEY), 9));
    const json = expectErrorJson(await h.call("update_item", { item_key: KEY, version: 5, fields: { title: "x" } }), "Version conflict");
    expect(json).toMatchObject({ code: "version_conflict", expected_version: 5, current_version: 9 });
    expect(json.hint).toMatch(/get_items_details/);
    expect(h.net.requests("PATCH", ITEM_URL)).toHaveLength(0);
  });

  it("UI-03 412 dal server (gara) → version_conflict, nessun retry (una sola PATCH)", async () => {
    h.net.on("GET", ITEM_URL, zSingle(article(KEY), 7));
    // La versione corrente passa il pre-check (7) ma il server risponde 412: un'altra scrittura è arrivata prima
    h.net.on("PATCH", ITEM_URL, zPatch({ version: 11 }));
    const json = expectErrorJson(await h.call("update_item", { item_key: KEY, version: 7, fields: { title: "x" } }), "Version conflict");
    expect(json).toMatchObject({ code: "version_conflict", expected_version: 7, current_version: 11 });
    expect(h.net.requests("PATCH", ITEM_URL)).toHaveLength(1);
  });

  it("UI-04 campi protetti → errore senza alcuna richiesta", async () => {
    for (const bad of ["itemType", "version", "collections", "parentItem", "relations", "dateAdded", "dateModified", "key"]) {
      const out = await h.call("update_item", { item_key: KEY, version: 7, fields: { [bad]: "x" } });
      const json = expectErrorJson(out, bad);
      expect(json.error).toMatch(/cannot be set/);
    }
    expect(h.net.calls).toHaveLength(0);
  });

  it("UI-05 campo non valido per il tipo → errore dopo il GET, nessuna PATCH", async () => {
    h.net.on("GET", ITEM_URL, zSingle(article(KEY), 7));
    const json = expectErrorJson(await h.call("update_item", { item_key: KEY, version: 7, fields: { thisIsNotAField: "x" } }), "Invalid fields");
    expect(json.problems.join(" ")).toMatch(/thisIsNotAField/);
    expect(h.net.requests("PATCH", ITEM_URL)).toHaveLength(0);
  });

  it("UI-06 creators sostituiti → mappati nella forma Zotero", async () => {
    h.net.on("GET", ITEM_URL, zSingle(article(KEY), 7));
    h.net.on("PATCH", ITEM_URL, zPatch({ version: 7, newVersion: 8 }));
    const out = await h.call("update_item", {
      item_key: KEY,
      version: 7,
      fields: {},
      creators: [{ firstName: "Grace", lastName: "Hopper" }, { name: "ACME", creatorType: "contributor" }],
    });
    expect(out.isError).toBe(false);
    expect(out.json).toMatchObject({ creators_replaced: true, updated_fields: [] });
    expect(h.net.requests("PATCH", ITEM_URL)[0].json()).toEqual({
      creators: [
        { firstName: "Grace", lastName: "Hopper", creatorType: "author" },
        { name: "ACME", creatorType: "contributor" },
      ],
    });
  });

  it("UI-07 title mappato al nome di campo del tipo (case → caseName)", async () => {
    h.net.on("GET", ITEM_URL, zSingle({ key: KEY, itemType: "case", caseName: "Vecchio" }, 7));
    h.net.on("PATCH", ITEM_URL, zPatch({ version: 7, newVersion: 8 }));
    const out = await h.call("update_item", { item_key: KEY, version: 7, fields: { title: "Nuovo caso" } });
    expect(out.isError).toBe(false);
    expect(h.net.requests("PATCH", ITEM_URL)[0].json()).toEqual({ caseName: "Nuovo caso" });
  });

  it("UI-08 item inesistente (404) → errore 'not found'", async () => {
    h.net.on("GET", ITEM_URL, zError(404, "Not found"));
    expectErrorJson(await h.call("update_item", { item_key: KEY, version: 7, fields: { title: "x" } }), "not found");
    expect(h.net.requests("PATCH", ITEM_URL)).toHaveLength(0);
  });

  it("UI-09 niente da aggiornare (fields vuoto, nessun creators) → errore senza richieste", async () => {
    const out = await h.call("update_item", { item_key: KEY, version: 7, fields: {} });
    expectErrorJson(out, "Nothing to update");
    expect(h.net.calls).toHaveLength(0);
  });

  it("UI-10 item_key malformato / version mancante → errore di validazione senza richieste", async () => {
    expectValidationError(await h.call("update_item", { item_key: "bad", version: 7, fields: { title: "x" } }), "item_key");
    expectValidationError(await h.call("update_item", { item_key: KEY, fields: { title: "x" } }), "version");
    expect(h.net.calls).toHaveLength(0);
  });

  it("UI-11 creatorType non valido per il tipo → errore dopo il GET", async () => {
    h.net.on("GET", ITEM_URL, zSingle({ key: KEY, itemType: "book", title: "B" }, 7));
    const json = expectErrorJson(
      await h.call("update_item", { item_key: KEY, version: 7, fields: {}, creators: [{ name: "n", creatorType: "director" }] }),
      "Invalid fields"
    );
    expect(json.problems.join(" ")).toMatch(/director/);
    expect(h.net.requests("PATCH", ITEM_URL)).toHaveLength(0);
  });

  it.each(ZOTERO_ERROR_STATUSES.filter((s) => s !== 404 && s !== 412))("UI-12 GET con HTTP %i → errore API", async (status) => {
    h.net.on("GET", ITEM_URL, zError(status));
    expectApiError(await h.call("update_item", { item_key: KEY, version: 7, fields: { title: "x" } }), status);
  });

  it("UI-13 errore di rete sul GET → isError", async () => {
    h.net.on("GET", ITEM_URL, networkError());
    expectApiError(await h.call("update_item", { item_key: KEY, version: 7, fields: { title: "x" } }));
  });
});
