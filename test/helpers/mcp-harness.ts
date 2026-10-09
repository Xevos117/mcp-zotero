import { vi, expect } from "vitest";
import { createRequire } from "module";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerAllTools } from "../../src/tools/index.js";
import { ZoteroApiInterface } from "../../src/types/zotero-types.js";
import { UnsafeOperationsMode } from "../../src/utils/unsafe-operations.js";
import { FakeNet } from "./fake-net.js";
import { USER_ID } from "./zotero-fake.js";

/**
 * Harness MCP in-process: vero McpServer + vero Client collegati in memoria,
 * vero `zotero-api-client`; solo `fetch` è sostituito da FakeNet.
 * Le asserzioni vedono esattamente ciò che vede un client MCP.
 */

export const TEST_API_KEY = "test-zotero-key-0000";

export interface ToolOutcome {
  isError: boolean;
  text: string;
  /** Testo del primo content parsato come JSON (undefined se non è JSON). */
  json: any;
  raw: unknown;
}

export interface Harness {
  net: FakeNet;
  client: Client;
  call(name: string, args?: Record<string, unknown>): Promise<ToolOutcome>;
  /** Chiama il tool senza il campo `arguments` nella richiesta. */
  callWithoutArguments(name: string): Promise<ToolOutcome>;
  close(): Promise<void>;
}

export interface HarnessOptions {
  userId?: string;
  unsafeOps?: UnsafeOperationsMode;
  /** Valore di UNPAYWALL_EMAIL; default "" (lookup disabilitato). */
  unpaywallEmail?: string;
  /** Valore di ZOTERO_API_KEY nell'ambiente; default TEST_API_KEY. */
  envApiKey?: string;
}

export function createZoteroClient(apiKey = TEST_API_KEY): ZoteroApiInterface {
  // Stesso caricamento di src/server.ts
  const require = createRequire(import.meta.url);
  const factory = require("zotero-api-client/lib/main-node.cjs").default;
  return factory(apiKey) as ZoteroApiInterface;
}

function toOutcome(result: any): ToolOutcome {
  const first = Array.isArray(result?.content) ? result.content[0] : undefined;
  const text = first && first.type === "text" ? String(first.text) : "";
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { isError: result?.isError === true, text, json, raw: result };
}

function errorOutcome(err: unknown): ToolOutcome {
  // Alcune versioni dell'SDK propagano gli errori di validazione come
  // errore JSON-RPC invece che come CallToolResult con isError: normalizziamo.
  const text = err instanceof Error ? err.message : String(err);
  return { isError: true, text, json: undefined, raw: err };
}

export async function startHarness(opts: HarnessOptions = {}): Promise<Harness> {
  vi.stubEnv("ZOTERO_API_KEY", opts.envApiKey ?? TEST_API_KEY);
  vi.stubEnv("UNPAYWALL_EMAIL", opts.unpaywallEmail ?? "");

  const net = new FakeNet().install();
  const server = new McpServer(
    { name: "zotero-test", version: "0.0.0" },
    { capabilities: { tools: {} } }
  );
  registerAllTools(server, createZoteroClient(), opts.userId ?? USER_ID, opts.unsafeOps ?? "none");

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "zotero-test-client", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  return {
    net,
    client,
    async call(name, args = {}) {
      try {
        return toOutcome(await client.callTool({ name, arguments: args }));
      } catch (err) {
        return errorOutcome(err);
      }
    },
    async callWithoutArguments(name) {
      try {
        return toOutcome(await client.callTool({ name }));
      } catch (err) {
        return errorOutcome(err);
      }
    },
    async close() {
      await client.close();
      await server.close();
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    },
  };
}

// ─── Asserzioni comuni ──────────────────────────────────────────

/** Errore di validazione argomenti: isError e il nome del campo nel messaggio. */
export function expectValidationError(outcome: ToolOutcome, field: string): void {
  expect(outcome.isError).toBe(true);
  expect(outcome.text).toContain(field);
}

/**
 * "Errore morbido": il server risponde con un JSON `{ error, ... }` senza
 * isError (comportamento attuale di formatErrorResponse).
 */
export function expectSoftError(outcome: ToolOutcome, message: string | RegExp): any {
  expect(outcome.isError).toBe(false);
  expect(outcome.json).toBeTypeOf("object");
  if (typeof message === "string") {
    expect(outcome.json.error).toContain(message);
  } else {
    expect(outcome.json.error).toMatch(message);
  }
  return outcome.json;
}

/** Errore "duro": il tool ha lanciato e l'SDK lo ha convertito in isError. */
export function expectToolError(outcome: ToolOutcome, contains?: string | RegExp): void {
  expect(outcome.isError).toBe(true);
  if (contains !== undefined) {
    if (typeof contains === "string") expect(outcome.text).toContain(contains);
    else expect(outcome.text).toMatch(contains);
  }
}

/** Header che porta la API key verso api.zotero.org (indipendente dal nome esatto). */
export function carriesApiKey(headers: Headers, key = TEST_API_KEY): boolean {
  for (const [, value] of headers) {
    if (value === key || value === `Bearer ${key}`) return true;
  }
  return false;
}

/** Stati HTTP d'errore Zotero da coprire in ogni tool. */
export const ZOTERO_ERROR_STATUSES = [403, 404, 412, 429, 500, 503] as const;
