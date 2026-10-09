import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { startFakeNetServer, FakeNetServer } from "./fake-net-server.js";
import { jsonResponse } from "../helpers/fake-net.js";
import {
  ZBASE,
  USER_ID,
  zList,
  zSingle,
  zWrite,
  zDeleted,
  zLibraryQuery,
  article,
  collection,
  pdfAttachment,
} from "../helpers/zotero-fake.js";
import { installUploadPipeline, installUnpaywall, servePdf, oaGold, UNPAYWALL_EMAIL } from "../helpers/pdf-pipeline.js";
import { makeDocx, para, zcite, readDocumentXml } from "../helpers/fixtures.js";

/**
 * E2E: avvia il server compilato (`node build/server.js`) su stdio come farebbe
 * un client MCP reale. Tutte le fetch del processo figlio (api.zotero.org,
 * doi.org, Unpaywall, storage, PDF) sono reindirizzate da fetch-redirect.mjs a
 * una FakeNet locale: niente rete reale né credenziali.
 * Prerequisito: `npm run build` (lo fa `npm run test:e2e`).
 */

const ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const SERVER = join(ROOT, "build", "server.js");
const PRELOAD = join(ROOT, "test", "e2e", "fetch-redirect.mjs");
const CALL_TIMEOUT_MS = 15_000;
const KILL_AFTER_MS = 5_000;

const ITEMS = `${ZBASE}/items`;

interface Spawned {
  client: Client;
  transport: StdioClientTransport;
  stderr: () => string;
  close(): Promise<void>;
}

async function spawnServer(fake: FakeNetServer, cwd: string, extraEnv: Record<string, string>): Promise<Spawned> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", PRELOAD, SERVER],
    cwd, // cartella vuota: nessun .env raccolto da dotenv
    env: {
      PATH: process.env.PATH ?? "",
      ZOTERO_API_KEY: "e2e-fake-key",
      ZOTERO_USER_ID: USER_ID,
      FAKE_NET_PORT: String(fake.port),
      ...extraEnv,
    },
    stderr: "pipe",
  });
  let err = "";
  transport.stderr?.on("data", (d: Buffer) => (err += d.toString()));
  const client = new Client({ name: "e2e-client", version: "0.0.0" });
  await client.connect(transport, { timeout: CALL_TIMEOUT_MS });
  return {
    client,
    transport,
    stderr: () => err,
    async close() {
      const pid = transport.pid;
      await Promise.race([client.close(), new Promise((r) => setTimeout(r, KILL_AFTER_MS))]);
      if (pid) {
        try {
          process.kill(pid, 0);
          process.kill(pid, "SIGKILL"); // ancora vivo dopo il bound → kill forzato
        } catch {
          // già terminato
        }
      }
    },
  };
}

async function call(s: Spawned, name: string, args: Record<string, unknown>) {
  try {
    const r = (await s.client.callTool({ name, arguments: args }, undefined, { timeout: CALL_TIMEOUT_MS })) as {
      content: Array<{ type: string; text: string }>;
      isError?: boolean;
    };
    const text = r.content?.[0]?.text ?? "";
    let json: any;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    return { isError: r.isError === true, text, json };
  } catch (e) {
    return { isError: true, text: e instanceof Error ? e.message : String(e), json: undefined };
  }
}

describe("e2e: build/server.js su stdio", () => {
  let fake: FakeNetServer;
  let cwd: string;
  let s: Spawned;

  beforeAll(async () => {
    if (!existsSync(SERVER)) throw new Error(`${SERVER} non trovato: eseguire prima "npm run build"`);
    fake = await startFakeNetServer();
    cwd = await mkdtemp(join(tmpdir(), "mcp-zotero-e2e-"));
    s = await spawnServer(fake, cwd, { UNSAFE_OPERATIONS: "all", UNPAYWALL_EMAIL });
  });

  afterAll(async () => {
    await s?.close();
    await fake?.close();
    if (cwd) await rm(cwd, { recursive: true, force: true });
  });

  it("E2E-01 initialize: serverInfo, capability tools e istruzioni", () => {
    expect(s.client.getServerVersion()?.name).toBe("zotero");
    expect(s.client.getServerCapabilities()?.tools).toBeDefined();
    expect(s.client.getInstructions()).toContain("inject_citations");
  });

  it("E2E-02 tools/list: 15 tool, ognuno con inputSchema object", async () => {
    const { tools } = await s.client.listTools(undefined, { timeout: CALL_TIMEOUT_MS });
    expect(tools).toHaveLength(15);
    for (const t of tools) {
      expect(t.inputSchema.type).toBe("object");
      expect(t.description).toBeTruthy();
    }
  });

  it("E2E-03 argomenti non validi → isError che cita il campo, per ogni tool con campi obbligatori", async () => {
    const cases: Array<[string, Record<string, unknown>, string]> = [
      ["get_collection_items", {}, "collectionKey"],
      ["get_items_details", {}, "item_keys"],
      ["get_item_fulltext", {}, "item_key"],
      ["add_items", { items: [] }, "items"],
      ["add_items_by_doi", {}, "dois"],
      ["add_linked_url_attachment", { url: "nope" }, "url"],
      ["create_collection", {}, "name"],
      ["delete_collection", { collection_key: "" }, "collection_key"],
      ["delete_items", { item_keys: [] }, "item_keys"],
      ["import_pdf_to_zotero", { url: "nope" }, "url"],
      ["inject_citations", { file_path: "/x.docx", style: "mla" }, "style"],
      ["search_library", { sort: "bogus" }, "sort"],
      ["get_collections", { include_trashed: "x" }, "include_trashed"],
      ["find_and_attach_pdfs", { dry_run: "x" }, "dry_run"],
    ];
    const before = fake.net.calls.length;
    for (const [tool, args, field] of cases) {
      const out = await call(s, tool, args);
      expect(out.isError, `${tool} dovrebbe fallire`).toBe(true);
      expect(out.text, tool).toContain(field);
    }
    expect(fake.net.calls.length).toBe(before);
  });

  it("E2E-04 get_user_id", async () => {
    expect((await call(s, "get_user_id", {})).json).toMatchObject({ user_id: USER_ID });
  });

  it("E2E-05 search_library", async () => {
    fake.net.on("GET", ITEMS, zLibraryQuery([article("AAAA1111"), article("BBBB2222")]));
    const out = await call(s, "search_library", { query: "attention" });
    expect(out.isError).toBe(false);
    expect(out.json.map((i: { key: string }) => i.key)).toEqual(["AAAA1111", "BBBB2222"]);
    const req = fake.net.requests("GET", ITEMS).at(-1)!;
    expect(req.url.searchParams.get("q")).toBe("attention");
    expect(req.headers.get("zotero-api-key")).toBe("e2e-fake-key");
    // default senza variabili di libreria: libreria utente /users/{ZOTERO_USER_ID}/
    expect(req.url.pathname.startsWith(`/users/${USER_ID}/`)).toBe(true);
  });

  it("E2E-06 get_collections", async () => {
    fake.net.on("GET", `${ZBASE}/collections`, zList([collection("COL00001", "ML"), collection("COL00009", "Old", { deleted: true })]));
    const out = await call(s, "get_collections", {});
    expect(out.json.map((c: { key: string }) => c.key)).toEqual(["COL00001"]);
  });

  it("E2E-07 get_collection_items", async () => {
    fake.net.on("GET", `${ZBASE}/collections/COL00001/items`, zList([article("AAAA1111"), pdfAttachment("ATT00001", "AAAA1111")]));
    const out = await call(s, "get_collection_items", { collectionKey: "COL00001" });
    expect(out.json).toMatchObject({ total_items: 2, returned_items: 1 });
  });

  it("E2E-08 get_items_details", async () => {
    fake.net.on("GET", ITEMS, zLibraryQuery([article("AAAA1111", { abstractNote: "abs" })]));
    const out = await call(s, "get_items_details", { item_keys: ["AAAA1111"], include_abstract: true });
    expect(out.json.AAAA1111).toMatchObject({ title: "Article AAAA1111", abstractNote: "abs" });
  });

  it("E2E-09 get_item_fulltext", async () => {
    fake.net.on("GET", `${ZBASE}/items/AAAA1111`, zSingle(article("AAAA1111")));
    fake.net.on("GET", `${ZBASE}/items/AAAA1111/children`, zList([pdfAttachment("ATT00001", "AAAA1111")]));
    fake.net.on("GET", `${ZBASE}/items/ATT00001/fulltext`, jsonResponse({ content: "Lorem ipsum", indexedPages: 1, totalPages: 1 }));
    const out = await call(s, "get_item_fulltext", { item_key: "AAAA1111" });
    expect(out.json).toMatchObject({ attachment_key: "ATT00001", text: "Lorem ipsum", truncated: false });
  });

  it("E2E-10 create_collection", async () => {
    fake.net.on("POST", `${ZBASE}/collections`, zWrite({ keys: ["NEWCOL01"] }));
    const out = await call(s, "create_collection", { name: "E2E" });
    expect(out.json).toEqual({ collection_key: "NEWCOL01", name: "E2E" });
  });

  it("E2E-11 add_items", async () => {
    fake.net.on("POST", ITEMS, zWrite({ keys: ["BOOK0001"] }));
    const out = await call(s, "add_items", { items: [{ itemType: "book", title: "E2E Book", creators: [{ name: "ACME" }] }] });
    expect(out.json.success).toEqual([{ index: 0, item_key: "BOOK0001", title: "E2E Book", item_type: "book" }]);
  });

  it("E2E-12 add_items_by_doi (doi.org + Unpaywall closed)", async () => {
    fake.net.on("GET", /^doi\.org\//, jsonResponse({ type: "article-journal", title: "DOI Paper", DOI: "10.1/e2e", author: [{ family: "Doe", given: "J" }] }));
    fake.net.on("POST", ITEMS, zWrite({ keys: ["DOIP0001"] }));
    installUnpaywall(fake.net, {});
    const out = await call(s, "add_items_by_doi", { dois: ["10.1/e2e"] });
    expect(out.json.success).toEqual([{ doi: "10.1/e2e", item_key: "DOIP0001", title: "DOI Paper" }]);
    expect(out.json.pdf_results[0]).toMatchObject({ pdf_attached: false, error: "No open access PDF found" });
  });

  it("E2E-13 add_linked_url_attachment", async () => {
    fake.net.on("POST", ITEMS, zWrite({ keys: ["LINK0001"] }));
    const out = await call(s, "add_linked_url_attachment", { url: "https://example.org/a.pdf", parent_item: "AAAA1111" });
    expect(out.json).toMatchObject({ item_key: "LINK0001", parent_item: "AAAA1111", link_mode: "linked_url" });
  });

  it("E2E-14 import_pdf_to_zotero (download + upload + fulltext)", async () => {
    servePdf(fake.net, "https://oa.example.org/e2e.pdf");
    fake.net.on("POST", ITEMS, zWrite({ keys: ["IMP00001"] }));
    installUploadPipeline(fake.net);
    const out = await call(s, "import_pdf_to_zotero", { url: "https://oa.example.org/e2e.pdf" });
    expect(out.isError).toBe(false);
    expect(out.json).toMatchObject({ item_key: "IMP00001", filename: "e2e.pdf", link_mode: "imported_url", fulltext_indexed: true });
  });

  it("E2E-15 find_and_attach_pdfs (dry_run)", async () => {
    fake.net.on("GET", ITEMS, zLibraryQuery([article("AAAA1111")]));
    fake.net.on("GET", `${ZBASE}/items/AAAA1111/children`, zList([]));
    installUnpaywall(fake.net, { "10.1000/aaaa1111": oaGold("https://oa.example.org/a.pdf") });
    const out = await call(s, "find_and_attach_pdfs", { item_keys: ["AAAA1111"], dry_run: true });
    expect(out.json).toMatchObject({ processed: 1, dry_run: true });
    expect(out.json.results[0]).toMatchObject({ status: "available", pdf_url: "https://oa.example.org/a.pdf" });
  });

  it("E2E-16 delete_collection (UNSAFE_OPERATIONS=all)", async () => {
    fake.net.on("GET", `${ZBASE}/collections/COL00001`, zSingle(collection("COL00001", "ML"), 12));
    fake.net.on("DELETE", `${ZBASE}/collections/COL00001`, zDeleted());
    const out = await call(s, "delete_collection", { collection_key: "COL00001" });
    expect(out.json).toEqual({ deleted: true, collection_key: "COL00001", name: "ML" });
    expect(fake.net.requests("DELETE", `${ZBASE}/collections/COL00001`)[0].headers.get("if-unmodified-since-version")).toBe("12");
  });

  it("E2E-17 delete_items (UNSAFE_OPERATIONS=all)", async () => {
    fake.net.on("GET", ITEMS, zLibraryQuery([article("AAAA1111")], 40));
    fake.net.on("DELETE", ITEMS, zDeleted());
    const out = await call(s, "delete_items", { item_keys: ["AAAA1111", "GONE0001"] });
    expect(out.json).toEqual({ deleted_keys: ["AAAA1111"], deleted_count: 1, not_found: ["GONE0001"] });
  });

  it("E2E-18 inject_citations su un .docx reale", async () => {
    fake.net.on("GET", `${ZBASE}/items/AAAA1111`, zSingle(article("AAAA1111")));
    const input = join(cwd, "paper.docx");
    await writeFile(input, await makeDocx(para("See ", zcite({ keys: "AAAA1111" }))));
    const out = await call(s, "inject_citations", { file_path: input });
    expect(out.json).toMatchObject({ output_path: join(cwd, "paper_cited.docx"), citations_found: 1, citations_injected: 1 });
    const xml = await readDocumentXml(await readFile(join(cwd, "paper_cited.docx")));
    expect(xml).toContain("ADDIN ZOTERO_ITEM CSL_CITATION");
    expect(xml).toContain("(Lovelace, 2023)");
  });

  it("E2E-19 errore API Zotero (403) → isError al client", async () => {
    fake.net.on("GET", `${ZBASE}/collections`, jsonResponse({}, { status: 403 }));
    const out = await call(s, "get_collections", {});
    expect(out.isError).toBe(true);
    expect(out.text).toContain("403");
  });

  it("E2E-20 nessuna richiesta del processo figlio è sfuggita alla tabella di route", () => {
    expect(fake.net.unmatched).toEqual([]);
    expect(s.stderr()).not.toContain("fake-net: no route");
  });
});

describe("e2e: configurazione del processo", () => {
  let fake: FakeNetServer;
  let cwd: string;

  beforeAll(async () => {
    fake = await startFakeNetServer();
    cwd = await mkdtemp(join(tmpdir(), "mcp-zotero-e2e-"));
  });
  afterAll(async () => {
    await fake?.close();
    if (cwd) await rm(cwd, { recursive: true, force: true });
  });

  it("E2E-21 senza UNSAFE_OPERATIONS i tool di cancellazione sono bloccati e non toccano la rete", async () => {
    const s = await spawnServer(fake, cwd, {});
    try {
      const di = await call(s, "delete_items", { item_keys: ["AAAA1111"] });
      expect(di.json.error).toContain("not allowed");
      expect(di.json.current_value).toBe("none");
      const dc = await call(s, "delete_collection", { collection_key: "COL00001" });
      expect(dc.json.error).toContain("not allowed");
      expect(fake.net.calls).toHaveLength(0);
    } finally {
      await s.close();
    }
  });

  it("E2E-22 UNSAFE_OPERATIONS=' ITEMS ' (case/spazi) abilita delete_items ma non delete_collection", async () => {
    const s = await spawnServer(fake, cwd, { UNSAFE_OPERATIONS: " ITEMS " });
    try {
      fake.net.on("GET", ITEMS, zLibraryQuery([article("AAAA1111")]));
      fake.net.on("DELETE", ITEMS, zDeleted());
      expect((await call(s, "delete_items", { item_keys: ["AAAA1111"] })).json.deleted_count).toBe(1);
      expect((await call(s, "delete_collection", { collection_key: "C" })).json.current_value).toBe("items");
    } finally {
      await s.close();
    }
  });

  it("E2E-23 senza ZOTERO_API_KEY/ZOTERO_USER_ID il processo esce con codice 1 e logga l'errore", async () => {
    const { code, stderr } = await new Promise<{ code: number | null; stderr: string }>((resolvePromise, reject) => {
      const child = spawn(process.execPath, ["--import", PRELOAD, SERVER], {
        cwd,
        env: { PATH: process.env.PATH ?? "", FAKE_NET_PORT: String(fake.port) },
        stdio: ["pipe", "pipe", "pipe"],
      });
      let err = "";
      child.stderr.on("data", (d: Buffer) => (err += d.toString()));
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error(`il server non è uscito entro ${KILL_AFTER_MS}ms`));
      }, KILL_AFTER_MS);
      child.on("exit", (c) => {
        clearTimeout(timer);
        resolvePromise({ code: c, stderr: err });
      });
    });
    expect(code).toBe(1);
    expect(stderr).toMatch(/Missing ZOTERO_API_KEY/); // testo completo può cambiare con nuove variabili di libreria
  });
});
