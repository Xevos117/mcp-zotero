import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
// @ts-expect-error plain .mjs script without type declarations
import { renderMcpConfig, TEMPLATE } from "../../test/live/agent/render-mcp.mjs";

/** Unica configurazione MCP dell'agente smoke: template con ${VAR}, reso in un file concreto dalla CI. */
describe("render-mcp: template MCP dell'agente smoke (RM)", () => {
  const template = readFileSync(TEMPLATE, "utf8");

  it("RM-01 variabili sostituite, node e percorso del server assoluti, opzionali vuote omesse, default applicati", () => {
    const config = renderMcpConfig(template, { ZOTERO_TEST_API_KEY: "k", ZOTERO_TEST_USER_ID: "42" }, "/repo");
    expect(config.mcpServers.zotero).toEqual({
      command: process.execPath,
      args: ["/repo/build/server.js"],
      env: { ZOTERO_API_KEY: "k", ZOTERO_USER_ID: "42", UNSAFE_OPERATIONS: "items" },
    });
    const all = renderMcpConfig(template, { ZOTERO_TEST_API_KEY: "k", ZOTERO_TEST_USER_ID: "42", UNSAFE_OPERATIONS: "all", UNPAYWALL_EMAIL: "a@b.c" }, "/repo");
    expect(all.mcpServers.zotero.env).toMatchObject({ UNSAFE_OPERATIONS: "all", UNPAYWALL_EMAIL: "a@b.c" });
  });

  it("RM-02 variabile obbligatoria mancante o vuota → errore che la nomina, senza valori", () => {
    expect(() => renderMcpConfig(template, { ZOTERO_TEST_API_KEY: "" }, "/repo")).toThrow("missing environment variable(s): ZOTERO_TEST_API_KEY, ZOTERO_TEST_USER_ID");
  });

  it("RM-03 il template non contiene valori: solo segnaposto ${…} per chiave, utente, email", () => {
    const env = JSON.parse(template).mcpServers.zotero.env;
    expect(env.ZOTERO_API_KEY).toBe("${ZOTERO_TEST_API_KEY}");
    expect(env.ZOTERO_USER_ID).toBe("${ZOTERO_TEST_USER_ID}");
    expect(env.UNPAYWALL_EMAIL).toMatch(/^\$\{UNPAYWALL_EMAIL/);
  });
});
