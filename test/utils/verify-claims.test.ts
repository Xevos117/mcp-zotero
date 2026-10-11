import { describe, it, expect } from "vitest";
// @ts-expect-error plain .mjs script without type declarations
import { attributableKeys } from "../../test/live/verify-claims.mjs";

/** Trascrizione nel formato SDK che claude-code-action scrive nel file di esecuzione. */
function transcript(calls: Array<[string, unknown, boolean?]>) {
  return calls.flatMap(([tool, result, isError], i) => [
    { type: "assistant", message: { content: [{ type: "tool_use", id: `t${i}`, name: `mcp__zotero__${tool}`, input: {} }] } },
    {
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: `t${i}`, is_error: isError ?? false, content: [{ type: "text", text: JSON.stringify(result) }] }] },
    },
  ]);
}

describe("verify-claims: attribuzione delle chiavi dalla trascrizione", () => {
  it("VC-01 chiavi create e cancellate lette dai risultati dei tool, non da testo qualsiasi", () => {
    const { created, deleted } = attributableKeys(
      transcript([
        ["create_collection", { collection_key: "CLLC2222", name: "mzt-x" }],
        ["add_items", { success: [{ index: 0, item_key: "ITEM2222", title: "mzt-x a" }] }],
        ["add_items_by_doi", { success: [{ doi: "10.1/x", item_key: "DQIT2222" }], failed: [], pdf_results: [{ attachment_key: "PDFA2222", pdf_attached: true }] }],
        ["add_linked_url_attachment", { item_key: "LINK2222", link_mode: "linked_url" }],
        ["delete_items", { deleted_keys: ["ITEM2222"], deleted_count: 1, not_found: ["ABCDEFGH"] }],
        ["delete_collection", { deleted: true, collection_key: "CLLC2222", name: "mzt-x" }],
      ])
    );
    expect([...created].sort()).toEqual(["CLLC2222", "DQIT2222", "ITEM2222", "LINK2222", "PDFA2222"]);
    expect([...deleted].sort()).toEqual(["CLLC2222", "ITEM2222"]);
  });

  it("VC-02 chiave ripetuta solo in not_found, in un errore o in un tool non Zotero → non attribuita", () => {
    const messages = [
      ...transcript([
        ["delete_items", { deleted_keys: [], deleted_count: 0, not_found: ["ABCDEFGH"] }],
        ["get_items_details", { ABCDEFGH: { title: "x" } }],
        ["delete_items", { error: "No items found for the given keys", item_keys: ["ABCDEFGH"] }, true],
      ]),
      { type: "assistant", message: { content: [{ type: "tool_use", id: "w", name: "Write", input: { content: "ABCDEFGH" } }] } },
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "w", content: '{"deleted_keys":["ABCDEFGH"]}' }] } },
    ];
    const { created, deleted } = attributableKeys(messages);
    expect(created.has("ABCDEFGH")).toBe(false);
    expect(deleted.has("ABCDEFGH")).toBe(false);
  });
});
