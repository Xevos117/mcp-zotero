import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Harness, startHarness, expectValidationError, expectToolError } from "../helpers/mcp-harness.js";
import { makeDocx, para, zcite, tempDir, TempDir } from "../helpers/fixtures.js";

/**
 * Ogni argomento che contiene una chiave Zotero finisce in un path dell'API (zotero-api-client non codifica i
 * segmenti e l'URL risolve "..") o in un filtro itemKey (ignorato dall'API se nessuna chiave è ben formata).
 * Una chiave malformata deve essere rifiutata dalla validazione prima di qualsiasi richiesta.
 */

const BAD_KEYS = [
  "../tags?tag=X&", // traversal verso un altro endpoint della stessa libreria
  "../collections?collectionKey=AAAA2222,BBBB3333", // cancellazione multipla
  "../../groups/777/items/ABCD2345", // altra libreria
  "zzzzzzzz", // minuscole: filtro itemKey ignorato
  "ZZZZZZZ0", // 0/1/O non esistono nelle chiavi Zotero
  "ABCD234", // 7 caratteri
  "AAAA2222,BBBB3333", // virgola
];

/** [tool, argomento, argomenti di base, come inserire la chiave] */
const CASES: Array<[string, string, Record<string, unknown>, (k: string) => unknown]> = [
  ["delete_items", "item_keys", {}, (k) => [k]],
  ["get_items_details", "item_keys", {}, (k) => [k]],
  ["find_and_attach_pdfs", "item_keys", { dry_run: true }, (k) => [k]],
  ["find_and_attach_pdfs", "collection_key", { dry_run: true }, (k) => k],
  ["delete_collection", "collection_key", {}, (k) => k],
  ["get_collection_items", "collectionKey", {}, (k) => k],
  ["get_item_fulltext", "item_key", {}, (k) => k],
  ["create_collection", "parent_collection", { name: "x" }, (k) => k],
  ["add_items", "collection_key", { items: [{ itemType: "book", title: "x" }] }, (k) => k],
  ["add_items_by_doi", "collection_key", { dois: ["10.1/x"], auto_attach_pdf: false }, (k) => k],
  ["add_linked_url_attachment", "parent_item", { url: "https://example.org/x" }, (k) => k],
  ["add_linked_url_attachment", "collections", { url: "https://example.org/x" }, (k) => [k]],
  ["import_pdf_to_zotero", "parent_item", { url: "https://example.org/x.pdf" }, (k) => k],
  ["import_pdf_to_zotero", "collections", { url: "https://example.org/x.pdf" }, (k) => [k]],
];

describe("validazione delle chiavi Zotero (path traversal, filtri itemKey ignorati)", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await startHarness({ unsafeOps: "all" });
  });
  afterEach(async () => {
    await h.close();
  });

  for (const [tool, arg, base, put] of CASES) {
    it.each(BAD_KEYS)(`KV-01 ${tool}.${arg} = %j → errore di validazione, nessuna richiesta`, async (key) => {
      expectValidationError(await h.call(tool, { ...base, [arg]: put(key) }), arg);
      expect(h.net.calls).toHaveLength(0);
    });
  }

  describe("inject_citations", () => {
    let dir: TempDir;
    beforeEach(async () => {
      dir = await tempDir();
    });
    afterEach(async () => {
      await dir.cleanup();
    });

    // i <zcite> accettano lettere e cifre (una GET per chiave, sconosciuta → 404): bloccati i caratteri di path e query
    it.each(["../tags?tag=X", "../../groups/777/items/ABCD2345", "ABCD2345?format=keys", "ABCD%2F2345"])("KV-02 chiave %j in un <zcite> → errore, nessuna richiesta", async (key) => {
      const input = await dir.file("bad.docx", await makeDocx(para(zcite({ keys: key.replace(/&/g, "&amp;") }))));
      expectToolError(await h.call("inject_citations", { file_path: input }), "Invalid Zotero item key");
      expect(h.net.calls).toHaveLength(0);
    });
  });
});
