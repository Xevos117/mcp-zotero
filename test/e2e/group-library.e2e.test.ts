import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startFakeNetServer, FakeNetServer } from "./fake-net-server.js";
import { SERVER, Spawned, spawnServer, call, runUntilExit } from "./server-process.js";
import { jsonResponse } from "../helpers/fake-net.js";
import {
  ZBASE,
  ZOTERO_HOST,
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
 * E2E librerie di gruppo (PR #7): server avviato con ZOTERO_LIBRARY_TYPE=group e
 * ZOTERO_LIBRARY_ID=777. Ogni richiesta a api.zotero.org deve usare /groups/777/,
 * comprese upload file e fulltext; override per chiamata e configurazioni rifiutate.
 */

const GROUP_ID = "777";
const GBASE = `${ZOTERO_HOST}/groups/${GROUP_ID}`;
const GITEMS = `${GBASE}/items`;

/** Path delle richieste a api.zotero.org registrate dopo l'indice `from`. */
function zoteroPaths(fake: FakeNetServer, from = 0): string[] {
  return fake.net.calls.slice(from).filter((c) => c.url.host === ZOTERO_HOST).map((c) => `${c.method} ${c.url.pathname}`);
}

describe("e2e: libreria di gruppo (ZOTERO_LIBRARY_TYPE=group, ZOTERO_LIBRARY_ID=777)", () => {
  let fake: FakeNetServer;
  let cwd: string;
  let s: Spawned;

  beforeAll(async () => {
    if (!existsSync(SERVER)) throw new Error(`${SERVER} non trovato: eseguire prima "npm run build"`);
    fake = await startFakeNetServer();
    cwd = await mkdtemp(join(tmpdir(), "mcp-zotero-e2e-group-"));
    s = await spawnServer(fake, cwd, {
      ZOTERO_LIBRARY_TYPE: "group",
      ZOTERO_LIBRARY_ID: GROUP_ID,
      UNSAFE_OPERATIONS: "all",
      UNPAYWALL_EMAIL,
    });
  });

  afterAll(async () => {
    await s?.close();
    await fake?.close();
    if (cwd) await rm(cwd, { recursive: true, force: true });
  });

  it("E2E-G01 get_user_id: library_type group, library_path groups/777, user_id da ZOTERO_USER_ID", async () => {
    const out = await call(s, "get_user_id", {});
    expect(out.json).toEqual({ user_id: USER_ID, library_type: "group", library_id: GROUP_ID, library_path: "groups/777" });
  });

  it("E2E-G02 lettura: search_library, get_collections, get_collection_items, get_items_details", async () => {
    fake.net.on("GET", GITEMS, zLibraryQuery([article("AAAA1111"), article("BBBB2222")]));
    fake.net.on("GET", `${GBASE}/collections`, zList([collection("COL00001", "Team")]));
    fake.net.on("GET", `${GBASE}/collections/COL00001/items`, zList([article("AAAA1111")]));

    const search = await call(s, "search_library", { query: "x" });
    expect(search.json.map((i: { key: string }) => i.key)).toEqual(["AAAA1111", "BBBB2222"]);
    expect((await call(s, "get_collections", {})).json.map((c: { key: string }) => c.key)).toEqual(["COL00001"]);
    expect((await call(s, "get_collection_items", { collectionKey: "COL00001" })).json).toMatchObject({ total_items: 1 });
    expect((await call(s, "get_items_details", { item_keys: ["BBBB2222"] })).json.BBBB2222).toMatchObject({ title: "Article BBBB2222" });
  });

  it("E2E-G03 get_item_fulltext legge /groups/777/items/{att}/fulltext", async () => {
    fake.net.on("GET", `${GITEMS}/AAAA1111`, zSingle(article("AAAA1111")));
    fake.net.on("GET", `${GITEMS}/AAAA1111/children`, zList([pdfAttachment("ATT00001", "AAAA1111")]));
    fake.net.on("GET", `${GITEMS}/ATT00001/fulltext`, jsonResponse({ content: "Testo di gruppo", indexedPages: 1, totalPages: 1 }));
    const out = await call(s, "get_item_fulltext", { item_key: "AAAA1111" });
    expect(out.json).toMatchObject({ attachment_key: "ATT00001", text: "Testo di gruppo" });
  });

  it("E2E-G04 scrittura: create_collection, add_items, add_linked_url_attachment", async () => {
    fake.net.on("POST", `${GBASE}/collections`, zWrite({ keys: ["GCOL0001"] }));
    expect((await call(s, "create_collection", { name: "Team" })).json).toEqual({ collection_key: "GCOL0001", name: "Team" });

    fake.net.on("POST", GITEMS, zWrite({ keys: ["GBOOK001"] }));
    const add = await call(s, "add_items", { items: [{ itemType: "book", title: "Group Book" }] });
    expect(add.json.success).toEqual([{ index: 0, item_key: "GBOOK001", title: "Group Book", item_type: "book" }]);

    fake.net.on("POST", GITEMS, zWrite({ keys: ["GLINK001"] }));
    const link = await call(s, "add_linked_url_attachment", { url: "https://example.org/a.pdf", parent_item: "GBOOK001" });
    expect(link.json).toMatchObject({ item_key: "GLINK001", link_mode: "linked_url" });
  });

  it("E2E-G05 import_pdf_to_zotero: item, upload file e PUT fulltext su /groups/777/", async () => {
    servePdf(fake.net, "https://oa.example.org/group.pdf");
    fake.net.on("POST", GITEMS, zWrite({ keys: ["GIMP0001"] }));
    installUploadPipeline(fake.net, { base: GBASE });
    const before = fake.net.calls.length;
    const out = await call(s, "import_pdf_to_zotero", { url: "https://oa.example.org/group.pdf" });
    expect(out.isError).toBe(false);
    expect(out.json).toMatchObject({ item_key: "GIMP0001", fulltext_indexed: true });
    expect(zoteroPaths(fake, before)).toEqual(
      expect.arrayContaining([
        "POST /groups/777/items",
        "POST /groups/777/items/GIMP0001/file",
        "PUT /groups/777/items/GIMP0001/fulltext",
      ])
    );
  });

  it("E2E-G06 add_items_by_doi con PDF open access allegato nel gruppo", async () => {
    fake.net.on("GET", /^doi\.org\//, jsonResponse({ type: "article-journal", title: "Group DOI", DOI: "10.1/grp", author: [{ family: "Doe", given: "J" }] }));
    fake.net.on("POST", GITEMS, zWrite({ keys: ["GDOI0001", "GDOIATT1"] }));
    installUnpaywall(fake.net, { "10.1/grp": oaGold("https://oa.example.org/grp.pdf") });
    servePdf(fake.net, "https://oa.example.org/grp.pdf");
    installUploadPipeline(fake.net, { base: GBASE });
    const out = await call(s, "add_items_by_doi", { dois: ["10.1/grp"] });
    expect(out.json.success).toEqual([{ doi: "10.1/grp", item_key: "GDOI0001", title: "Group DOI" }]);
    expect(out.json.pdf_results[0]).toMatchObject({ pdf_attached: true });
  });

  it("E2E-G07 delete_items e delete_collection su /groups/777/", async () => {
    fake.net.on("GET", GITEMS, zLibraryQuery([article("AAAA1111")], 40));
    fake.net.on("DELETE", GITEMS, zDeleted());
    expect((await call(s, "delete_items", { item_keys: ["AAAA1111"] })).json).toMatchObject({ deleted_count: 1 });
    fake.net.on("GET", `${GBASE}/collections/COL00001`, zSingle(collection("COL00001", "Team"), 9));
    fake.net.on("DELETE", `${GBASE}/collections/COL00001`, zDeleted());
    expect((await call(s, "delete_collection", { collection_key: "COL00001" })).json).toMatchObject({ deleted: true });
  });

  it("E2E-G08 inject_citations: URI http://zotero.org/groups/777/items/{key} nel field code", async () => {
    fake.net.on("GET", `${GITEMS}/AAAA1111`, zSingle(article("AAAA1111")));
    const input = join(cwd, "group.docx");
    await writeFile(input, await makeDocx(para("See ", zcite({ keys: "AAAA1111" }))));
    const out = await call(s, "inject_citations", { file_path: input });
    expect(out.json).toMatchObject({ citations_injected: 1 });
    const xml = await readDocumentXml(await readFile(join(cwd, "group_cited.docx")));
    expect(xml).toContain("http://zotero.org/groups/777/items/AAAA1111");
    expect(xml).not.toContain("zotero.org/users/");
  });

  it("E2E-G09 find_and_attach_pdfs (dry_run) legge item e children dal gruppo", async () => {
    fake.net.on("GET", GITEMS, zLibraryQuery([article("AAAA1111")]));
    fake.net.on("GET", `${GITEMS}/AAAA1111/children`, zList([]));
    installUnpaywall(fake.net, { "10.1000/aaaa1111": oaGold("https://oa.example.org/a.pdf") });
    const out = await call(s, "find_and_attach_pdfs", { item_keys: ["AAAA1111"], dry_run: true });
    expect(out.json.results[0]).toMatchObject({ status: "available" });
  });

  it("E2E-G10 ogni richiesta a api.zotero.org finora ha usato solo /groups/777/", () => {
    const paths = zoteroPaths(fake);
    expect(paths.length).toBeGreaterThan(15);
    expect(paths.filter((p) => !p.split(" ")[1].startsWith("/groups/777/"))).toEqual([]);
    expect(fake.net.unmatched).toEqual([]);
  });

  it("E2E-G11 override per chiamata: library_type user → /users/{ZOTERO_USER_ID}, group 888 → /groups/888", async () => {
    fake.net.on("GET", `${ZBASE}/collections`, zList([collection("UCOL0001", "Mine")]));
    fake.net.on("GET", `${ZOTERO_HOST}/groups/888/collections`, zList([collection("OCOL0001", "Other")]));
    const before = fake.net.calls.length;
    expect((await call(s, "get_collections", { library_type: "user" })).json.map((c: { key: string }) => c.key)).toEqual(["UCOL0001"]);
    expect((await call(s, "get_collections", { library_id: "888" })).json.map((c: { key: string }) => c.key)).toEqual(["OCOL0001"]);
    expect(zoteroPaths(fake, before)).toEqual([`GET /users/${USER_ID}/collections`, "GET /groups/888/collections"]);
  });

  it("E2E-G12 override con library_id non numerico → isError, nessuna richiesta di rete", async () => {
    const before = fake.net.calls.length;
    const cases: Array<[string, Record<string, unknown>]> = [
      ["get_collections", { library_id: "abc" }],
      ["search_library", { library_type: "group", library_id: "777/../../users/1" }],
      ["get_item_fulltext", { item_key: "AAAA1111", library_id: "12a" }],
      ["create_collection", { name: "X", library_id: "" }],
      ["delete_items", { item_keys: ["AAAA1111"], library_id: "-1" }],
      ["get_collections", { library_type: "team" }],
    ];
    for (const [tool, args] of cases) {
      const out = await call(s, tool, args);
      expect(out.isError, `${tool} ${JSON.stringify(args)}`).toBe(true);
      expect(out.text, tool).toMatch(/library_(id|type)/);
    }
    expect(fake.net.calls.length).toBe(before);
  });
});

describe("e2e: configurazione libreria rifiutata all'avvio", () => {
  let fake: FakeNetServer;
  let cwd: string;
  const BASE_ENV = { ZOTERO_API_KEY: "e2e-fake-key", ZOTERO_USER_ID: USER_ID };

  beforeAll(async () => {
    fake = await startFakeNetServer();
    cwd = await mkdtemp(join(tmpdir(), "mcp-zotero-e2e-group-"));
  });
  afterAll(async () => {
    await fake?.close();
    if (cwd) await rm(cwd, { recursive: true, force: true });
  });

  it("E2E-G13 ZOTERO_LIBRARY_TYPE=group senza ZOTERO_LIBRARY_ID → exit 1, nessuna richiesta", async () => {
    const { code, stderr } = await runUntilExit(fake, cwd, { ...BASE_ENV, ZOTERO_LIBRARY_TYPE: "group" });
    expect(code).toBe(1);
    expect(stderr).toMatch(/requires ZOTERO_LIBRARY_ID/);
    expect(fake.net.calls).toHaveLength(0);
  });

  it.each([
    [{ ZOTERO_LIBRARY_TYPE: "group", ZOTERO_LIBRARY_ID: "team-a" }, /ZOTERO_LIBRARY_ID must be a numeric/],
    [{ ZOTERO_LIBRARY_TYPE: "organization", ZOTERO_LIBRARY_ID: GROUP_ID }, /ZOTERO_LIBRARY_TYPE must be 'user' or 'group'/],
  ])("E2E-G14 configurazione non valida %o → exit 1", async (env, message) => {
    const { code, stderr } = await runUntilExit(fake, cwd, { ...BASE_ENV, ...env });
    expect(code).toBe(1);
    expect(stderr).toMatch(message);
    expect(fake.net.calls).toHaveLength(0);
  });
});
