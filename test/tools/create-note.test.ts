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
import { ZBASE, zSingle, zWrite, zError, article, pdfAttachment } from "../helpers/zotero-fake.js";

const ITEMS = `${ZBASE}/items`;
const PARENT = "AAAARRRR";
const PARENT_URL = `${ZBASE}/items/${PARENT}`;

describe("create_note (MCP)", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await startHarness();
  });
  afterEach(async () => {
    await h.close();
  });

  it("CN-01 nota figlia di un item regolare → item_key e parent_item_key", async () => {
    h.net.on("GET", PARENT_URL, zSingle(article(PARENT)));
    h.net.on("POST", ITEMS, zWrite({ keys: ["NOTEQQQR"] }));
    const out = await h.call("create_note", { parent_item_key: PARENT, note: "Una nota semplice" });
    expect(out.isError).toBe(false);
    expect(out.json).toEqual({ item_key: "NOTEQQQR", parent_item_key: PARENT });
    const posted = h.net.requests("POST", ITEMS).at(-1)!.json<Array<Record<string, unknown>>>()[0];
    expect(posted).toEqual({
      itemType: "note",
      parentItem: PARENT,
      note: "<p>Una nota semplice</p>",
      tags: [],
      collections: [],
    });
  });

  it("CN-02 testo in paragrafi e righe: blank line → <p>, newline singolo → <br/>, XML escapato", async () => {
    h.net.on("GET", PARENT_URL, zSingle(article(PARENT)));
    h.net.on("POST", ITEMS, zWrite({ keys: ["NOTEQQQ2"] }));
    await h.call("create_note", {
      parent_item_key: PARENT,
      note: "Primo & <importante>\nseconda riga\n\nSecondo paragrafo",
    });
    const posted = h.net.requests("POST", ITEMS).at(-1)!.json<Array<{ note: string }>>()[0];
    expect(posted.note).toBe(
      "<p>Primo &amp; &lt;importante&gt;<br/>seconda riga</p><p>Secondo paragrafo</p>"
    );
  });

  it("CN-03 tag applicati alla nota", async () => {
    h.net.on("GET", PARENT_URL, zSingle(article(PARENT)));
    h.net.on("POST", ITEMS, zWrite({ keys: ["NOTEQQQ3"] }));
    await h.call("create_note", { parent_item_key: PARENT, note: "x", tags: ["letta", "mzt"] });
    const posted = h.net.requests("POST", ITEMS).at(-1)!.json<Array<{ tags: unknown }>>()[0];
    expect(posted.tags).toEqual([{ tag: "letta" }, { tag: "mzt" }]);
  });

  it("CN-04 parent inesistente (404) → errore 'not found', nessuna scrittura", async () => {
    h.net.on("GET", PARENT_URL, zError(404, "Not found"));
    const out = await h.call("create_note", { parent_item_key: PARENT, note: "x" });
    const json = expectErrorJson(out, "not found");
    expect(json.hint).toBeTypeOf("string");
    expect(h.net.requests("POST", ITEMS)).toHaveLength(0);
  });

  it("CN-05 parent è una nota o un allegato → errore, nessuna scrittura", async () => {
    h.net.on("GET", PARENT_URL, zSingle({ key: PARENT, itemType: "note", note: "<p>esistente</p>" }));
    const note = expectErrorJson(await h.call("create_note", { parent_item_key: PARENT, note: "x" }), "note");
    expect(note.error).toMatch(/regular item/);

    h.net.on("GET", PARENT_URL, zSingle(pdfAttachment(PARENT, "ZZZZ2222")));
    const att = expectErrorJson(await h.call("create_note", { parent_item_key: PARENT, note: "x" }), "attachment");
    expect(att.error).toMatch(/regular item/);
    expect(h.net.requests("POST", ITEMS)).toHaveLength(0);
  });

  it("CN-06 scrittura rifiutata → errore strutturato con details", async () => {
    h.net.on("GET", PARENT_URL, zSingle(article(PARENT)));
    h.net.on("POST", ITEMS, zWrite({ fail: { 0: { code: 400, message: "Invalid note" } } }));
    const json = expectErrorJson(await h.call("create_note", { parent_item_key: PARENT, note: "x" }), "Failed to create note");
    expect(json).toHaveProperty("details");
  });

  it("CN-07 parent_item_key malformato → errore di validazione senza richieste", async () => {
    const out = await h.call("create_note", { parent_item_key: "bad", note: "x" });
    expectValidationError(out, "parent_item_key");
    expect(h.net.calls).toHaveLength(0);
  });

  it("CN-08 note vuota → errore di validazione senza richieste", async () => {
    const out = await h.call("create_note", { parent_item_key: PARENT, note: "" });
    expectValidationError(out, "note");
    expect(h.net.calls).toHaveLength(0);
  });

  it.each(ZOTERO_ERROR_STATUSES.filter((s) => s !== 404))("CN-09 GET del parent con HTTP %i → errore API", async (status) => {
    h.net.on("GET", PARENT_URL, zError(status));
    expectApiError(await h.call("create_note", { parent_item_key: PARENT, note: "x" }), status);
  });

  it("CN-10 errore di rete sul GET del parent → isError", async () => {
    h.net.on("GET", PARENT_URL, networkError());
    expectApiError(await h.call("create_note", { parent_item_key: PARENT, note: "x" }));
  });
});
