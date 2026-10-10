import { describe, it, expect, vi, afterEach } from "vitest";
import { handleToolCall } from "./index.js";
import { ZoteroApiInterface } from "../types/zotero-types.js";

// Errors thrown by any tool are logged once by the shared wrapper in tools/index.ts.
function failingApi(status: number): ZoteroApiInterface {
  const err = Object.assign(new Error(`HTTP ${status}`), { response: { status, url: "https://api.zotero.org/users/1/items" } });
  const chain: Record<string, unknown> = {};
  const handler: ProxyHandler<Record<string, unknown>> = {
    get: (_t, prop) => (prop === "get" ? async () => { throw err; } : () => new Proxy(chain, handler)),
  };
  return new Proxy(chain, handler) as unknown as ZoteroApiInterface;
}

describe("tool error logging (runTool)", () => {
  afterEach(() => vi.restoreAllMocks());

  it.each(["search_library", "get_collections", "get_items_details"])(
    "%s: a Zotero API error is rethrown and logged once with tool, status and URL",
    async (tool) => {
      const writes: string[] = [];
      vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
        writes.push(String(chunk));
        return true;
      });
      const args = tool === "get_items_details" ? { item_keys: ["ABCD1234"] } : {};
      await expect(handleToolCall(tool, args, failingApi(503), "1")).rejects.toThrow("HTTP 503");
      const logged = writes.map((w) => JSON.parse(w)).filter((e) => e.message === "Tool execution failed");
      expect(logged).toEqual([
        expect.objectContaining({ level: "error", tool, status: 503, url: "https://api.zotero.org/users/1/items" }),
      ]);
    }
  );

  it("rejects unknown tools", async () => {
    await expect(handleToolCall("nope", {}, failingApi(500), "1")).rejects.toThrow("Unknown tool: nope");
  });
});
