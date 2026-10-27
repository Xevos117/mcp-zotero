import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Harness, startHarness } from "../helpers/mcp-harness.js";
import { PROMPTS, promptArgumentNames, promptManifestText } from "../../src/prompts/index.js";

/**
 * MCP prompts (`src/prompts/index.ts`): the registered prompts, the rendered text and the alignment of
 * manifest.json's prompts[] (Claude Desktop extension) with the source of truth in PROMPTS.
 */

const root = fileURLToPath(new URL("../..", import.meta.url));
const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));

describe("prompts MCP (PR)", () => {
  let h: Harness;
  let listed: Array<{ name: string; description?: string; arguments?: Array<{ name: string; required?: boolean }> }>;

  beforeAll(async () => {
    h = await startHarness();
    listed = (await h.client.listPrompts()).prompts as typeof listed;
  });
  afterAll(async () => {
    await h.close();
  });

  // Optional zod args (.optional()) must surface as non-required in the MCP prompt arguments list
  const REQUIRED: Record<string, string[]> = {
    cite_word_document: ["file_path"],
    write_cited_document: ["topic", "output_path"],
    import_references: ["dois"],
    note_from_item: ["item_key"],
    check_bibliography: ["collection_key"],
  };

  it("PR-01 prompts/list: i prompt attesi con i loro argomenti e obbligatorietà", () => {
    expect(listed.map((p) => p.name)).toEqual(PROMPTS.map((p) => p.name));
    for (const def of PROMPTS) {
      const got = listed.find((p) => p.name === def.name)!;
      expect(got.description).toBe(def.description);
      expect((got.arguments ?? []).map((a) => a.name)).toEqual(promptArgumentNames(def));
      expect((got.arguments ?? []).filter((a) => a.required).map((a) => a.name)).toEqual(REQUIRED[def.name]);
    }
  });

  it("PR-02 prompts/get: il testo è reso con gli argomenti forniti", async () => {
    const r = await h.client.getPrompt({
      name: "cite_word_document",
      arguments: { file_path: "/tmp/paper.docx", style: "ieee" },
    });
    expect(r.messages).toHaveLength(1);
    const msg = r.messages[0];
    expect(msg.role).toBe("user");
    expect(msg.content.type).toBe("text");
    const text = (msg.content as { text: string }).text;
    expect(text).toContain("/tmp/paper.docx");
    expect(text).toContain('style "ieee"');
    expect(text).not.toContain("${arguments.");
  });

  it("PR-03 prompts/get: argomento opzionale omesso → default nel testo", async () => {
    const r = await h.client.getPrompt({ name: "cite_word_document", arguments: { file_path: "/x.docx" } });
    expect((r.messages[0].content as { text: string }).text).toContain('style "apa"');
  });

  it("PR-04 manifest.json prompts[] allineato a PROMPTS (nomi, ordine, argomenti, testo con placeholder)", () => {
    expect(manifest.prompts_generated).toBe(false);
    expect(manifest.prompts.map((p: { name: string }) => p.name)).toEqual(PROMPTS.map((p) => p.name));
    const byName = Object.fromEntries(manifest.prompts.map((p: { name: string }) => [p.name, p]));
    for (const def of PROMPTS) {
      const m = byName[def.name];
      expect(m, def.name).toBeDefined();
      expect(m.description, def.name).toBe(def.description);
      expect(m.arguments, def.name).toEqual(promptArgumentNames(def));
      expect(m.text, def.name).toBe(promptManifestText(def));
      // every argument appears as a ${arguments.x} placeholder in the manifest text
      for (const arg of promptArgumentNames(def)) expect(m.text, `${def.name}.${arg}`).toContain(`\${arguments.${arg}}`);
    }
  });

  it("PR-05 ogni template nomina almeno un tool del server", () => {
    const toolNames = ["inject_citations", "create_cited_document", "add_items_by_doi", "add_items", "search_library", "get_items_details", "get_item_fulltext", "create_note", "find_duplicates"];
    for (const def of PROMPTS) {
      const text = def.template(Object.fromEntries(promptArgumentNames(def).map((k) => [k, "X"])));
      expect(toolNames.some((t) => text.includes(t)), def.name).toBe(true);
    }
  });
});
