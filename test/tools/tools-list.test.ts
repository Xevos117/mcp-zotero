import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Harness, startHarness } from "../helpers/mcp-harness.js";

/**
 * Contratto di tools/list: nomi, campi obbligatori, proprietà, enum e default
 * dello JSON Schema generato da zod + SDK. Le asserzioni evitano dettagli
 * dipendenti dalla versione (ordine chiavi, $schema, additionalProperties).
 */

const EXPECTED: Record<string, { required: string[]; properties: string[] }> = {
  search_library: { required: [], properties: ["query", "sort", "direction", "limit"] },
  get_collections: { required: [], properties: ["include_trashed"] },
  get_collection_items: { required: ["collectionKey"], properties: ["collectionKey", "excludeAttachments"] },
  get_items_details: { required: ["item_keys"], properties: ["item_keys", "include_abstract"] },
  get_item_fulltext: { required: ["item_key"], properties: ["item_key", "max_characters"] },
  get_user_id: { required: [], properties: [] },
  add_items: { required: ["items"], properties: ["items", "collection_key", "tags"] },
  add_items_by_doi: { required: ["dois"], properties: ["dois", "collection_key", "tags", "auto_attach_pdf"] },
  add_linked_url_attachment: {
    required: ["url"],
    properties: ["url", "title", "content_type", "parent_item", "collections", "tags"],
  },
  create_collection: { required: ["name"], properties: ["name", "parent_collection"] },
  delete_collection: { required: ["collection_key"], properties: ["collection_key"] },
  delete_items: { required: ["item_keys"], properties: ["item_keys"] },
  import_pdf_to_zotero: {
    required: ["url"],
    properties: ["url", "filename", "title", "content_type", "parent_item", "collections", "tags"],
  },
  find_and_attach_pdfs: {
    required: [],
    properties: ["item_keys", "collection_key", "skip_if_attachment_exists", "dry_run"],
  },
  inject_citations: { required: ["file_path"], properties: ["file_path", "style"] },
};

const LIBRARY_ARGS = ["library_type", "library_id"];

describe("tools/list (MCP)", () => {
  let h: Harness;
  let tools: Array<{ name: string; description?: string; inputSchema: Record<string, any> }>;

  beforeAll(async () => {
    h = await startHarness();
    tools = (await h.client.listTools()).tools as typeof tools;
  });
  afterAll(async () => {
    await h.close();
  });

  it("TL-01 espone esattamente i 15 tool attesi", () => {
    expect(tools.map((t) => t.name).sort()).toEqual(Object.keys(EXPECTED).sort());
  });

  it.each(Object.entries(EXPECTED))("TL-02 %s: schema object con required/properties attesi e descrizione", (name, exp) => {
    const t = tools.find((x) => x.name === name)!;
    expect(t.description?.length ?? 0).toBeGreaterThan(20);
    expect(t.inputSchema.type).toBe("object");
    // Override di libreria per chiamata (PR #7): opzionale su tutti i tool tranne get_user_id
    const expected = name === "get_user_id" ? exp.properties : [...exp.properties, ...LIBRARY_ARGS];
    expect(Object.keys(t.inputSchema.properties ?? {}).sort()).toEqual([...expected].sort());
    expect([...(t.inputSchema.required ?? [])].sort()).toEqual([...exp.required].sort());
  });

  it("TL-03 enum di sort/direction/style e default documentati", () => {
    const props = (n: string) => tools.find((t) => t.name === n)!.inputSchema.properties;
    expect([...props("search_library").sort.enum].sort()).toEqual(["creator", "date", "dateAdded", "dateModified", "title"]);
    expect(props("search_library").sort.default).toBe("dateAdded");
    expect(props("search_library").direction.default).toBe("desc");
    expect(props("search_library").limit.default).toBe(25);
    expect([...props("inject_citations").style.enum].sort()).toEqual(["apa", "chicago", "harvard", "ieee", "vancouver"]);
    expect(props("inject_citations").style.default).toBe("apa");
    expect(props("add_items_by_doi").auto_attach_pdf.default).toBe(true);
    expect(props("get_item_fulltext").max_characters.default).toBe(50000);
    expect(props("find_and_attach_pdfs").dry_run.default).toBe(false);
    expect(props("import_pdf_to_zotero").content_type.default).toBe("application/pdf");
  });

  it("TL-08 library_type enum user/group e library_id numerico, mai obbligatori", () => {
    for (const t of tools.filter((x) => x.name !== "get_user_id")) {
      expect([...t.inputSchema.properties.library_type.enum].sort()).toEqual(["group", "user"]);
      expect(t.inputSchema.properties.library_id).toMatchObject({ type: "string", pattern: "^\\d+$" });
      expect(t.inputSchema.required ?? []).not.toContain("library_type");
      expect(t.inputSchema.required ?? []).not.toContain("library_id");
    }
  });

  it("TL-04 vincoli di cardinalità: delete_items 1..50, add_items min 1, delete_collection minLength 1", () => {
    const props = (n: string) => tools.find((t) => t.name === n)!.inputSchema.properties;
    expect(props("delete_items").item_keys).toMatchObject({ type: "array", minItems: 1, maxItems: 50 });
    expect(props("add_items").items).toMatchObject({ type: "array", minItems: 1 });
    expect(props("delete_collection").collection_key).toMatchObject({ type: "string", minLength: 1 });
  });

  it("TL-05 add_items: itemType è un enum con tutti i 37 tipi Zotero", () => {
    const items = tools.find((t) => t.name === "add_items")!.inputSchema.properties.items;
    const itemType = items.items.properties.itemType;
    expect(itemType.enum).toHaveLength(37);
    expect(itemType.enum).toEqual(expect.arrayContaining(["journalArticle", "book", "thesis", "case", "statute"]));
    expect([...items.items.required].sort()).toEqual(["itemType", "title"]);
  });

  it("TL-06 url di add_linked_url_attachment/import_pdf_to_zotero dichiarati come URI", () => {
    for (const n of ["add_linked_url_attachment", "import_pdf_to_zotero"]) {
      const url = tools.find((t) => t.name === n)!.inputSchema.properties.url;
      expect(url.type).toBe("string");
      expect(url.format).toBe("uri");
    }
  });

  it("TL-07 tool sconosciuto → errore (isError o errore JSON-RPC)", async () => {
    const out = await h.call("does_not_exist", {});
    expect(out.isError).toBe(true);
    expect(out.text).toContain("does_not_exist");
  });
});
