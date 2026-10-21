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
    "%s: a Zotero API error becomes a structured error with a hint, logged once with tool, status and URL",
    async (tool) => {
      const writes: string[] = [];
      vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
        writes.push(String(chunk));
        return true;
      });
      const args = tool === "get_items_details" ? { item_keys: ["ABCDR234"] } : {};
      const result = await handleToolCall(tool, args, failingApi(503), "1");
      expect(result.isError).toBe(true);
      const body = JSON.parse((result.content[0] as { text: string }).text);
      expect(body).toMatchObject({ http_status: 503, error: expect.stringContaining("temporarily unavailable") });
      expect(body.hint).toMatch(/retry once/);
      expect(JSON.stringify(body)).not.toContain("api.zotero.org/users/1");
      const logged = writes.map((w) => JSON.parse(w)).filter((e) => e.message === "Tool execution failed");
      expect(logged).toEqual([
        expect.objectContaining({ level: "error", tool, status: 503, url: "https://api.zotero.org/users/1/items" }),
      ]);
    }
  );

  it("rethrows errors that are not API, timeout or network errors (bugs keep their message)", async () => {
    const chain: Record<string, unknown> = {};
    const handler: ProxyHandler<Record<string, unknown>> = {
      get: (_t, prop) => (prop === "get" ? async () => { throw new RangeError("boom"); } : () => new Proxy(chain, handler)),
    };
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    await expect(handleToolCall("search_library", {}, new Proxy(chain, handler) as unknown as ZoteroApiInterface, "1")).rejects.toThrow("boom");
  });

  it("rejects unknown tools", async () => {
    await expect(handleToolCall("nope", {}, failingApi(500), "1")).rejects.toThrow("Unknown tool: nope");
  });
});
