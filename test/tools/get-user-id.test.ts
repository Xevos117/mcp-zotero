import { describe, it, expect, afterEach, vi } from "vitest";
import { Harness, startHarness } from "../helpers/mcp-harness.js";
import { USER_ID } from "../helpers/zotero-fake.js";

describe("get_user_id (MCP)", () => {
  let h: Harness;
  afterEach(async () => {
    await h.close();
  });

  it("GUI-01 restituisce lo user id configurato senza chiamate di rete", async () => {
    h = await startHarness();
    const out = await h.call("get_user_id", {});
    expect(out.isError).toBe(false);
    expect(out.json).toMatchObject({ user_id: USER_ID }); // campi aggiuntivi (es. libreria) ammessi
    expect(h.net.calls).toHaveLength(0);
  });

  it("GUI-02 argomenti extra ignorati", async () => {
    h = await startHarness();
    const out = await h.call("get_user_id", { foo: "bar" });
    expect(out.isError).toBe(false);
    expect(out.json).toMatchObject({ user_id: USER_ID }); // campi aggiuntivi (es. libreria) ammessi
  });

  it("GUI-03 user id restituito verbatim (stringa, nessuna conversione numerica)", async () => {
    h = await startHarness({ userId: "0012345" });
    const out = await h.call("get_user_id", {});
    expect(out.json.user_id).toBe("0012345");
  });

  it("GUI-04 user id vuoto → errore 'library ID is not set' (validazione id della PR #7)", async () => {
    h = await startHarness({ userId: "" });
    const out = await h.call("get_user_id", {});
    expect(out.isError).toBe(true);
    expect(out.text).toMatch(/library ID is not set/);
    expect(h.net.calls).toHaveLength(0);
  });

  it("GUI-06 libreria utente: library_type, library_id e library_path", async () => {
    h = await startHarness();
    const out = await h.call("get_user_id", {});
    expect(out.json).toEqual({
      user_id: USER_ID,
      library_type: "user",
      library_id: USER_ID,
      library_path: `users/${USER_ID}`,
    });
  });

  it("GUI-07 libreria di gruppo: user_id reale da ZOTERO_USER_ID, library_path groups/{id}", async () => {
    h = await startHarness({ userId: "777" });
    vi.stubEnv("ZOTERO_LIBRARY_TYPE", "group");
    vi.stubEnv("ZOTERO_USER_ID", USER_ID);
    const out = await h.call("get_user_id", {});
    expect(out.json).toEqual({
      user_id: USER_ID,
      library_type: "group",
      library_id: "777",
      library_path: "groups/777",
    });
  });

  // BUG: con @modelcontextprotocol/sdk 1.27 una tools/call senza il campo
  // `arguments` (opzionale per la spec MCP) su un tool senza parametri viene
  // rifiutata con "expected object, received undefined". Origine: validazione
  // dell'SDK sull'inputSchema `{}` registrato in tools/index.ts.
  it.fails("GUI-05 BUG tools/call senza 'arguments' deve funzionare per un tool senza parametri", async () => {
    h = await startHarness();
    const out = await h.callWithoutArguments("get_user_id");
    expect(out.isError).toBe(false);
    expect(out.json).toMatchObject({ user_id: USER_ID }); // campi aggiuntivi (es. libreria) ammessi
  });
});
