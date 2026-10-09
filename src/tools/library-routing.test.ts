import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { handleToolCall } from "./index.js";
import { ZoteroApiInterface } from "../types/zotero-types.js";

// Records every library(type, id) call made through the chain, so the tests assert
// which library a tool actually talks to instead of re-checking resolveLibrary().
function createRecordingApi(data: unknown = [], writeData: unknown[] = []) {
  const libraryCalls: Array<[string, string]> = [];
  const response = {
    getData: () => data,
    getVersion: () => 7,
    getTotalResults: () => (Array.isArray(data) ? data.length : 1),
  };
  const writeResponse = {
    isSuccess: () => true,
    getData: () => writeData,
    getErrors: () => ({}),
    getEntityByIndex: (i: number) => writeData[i],
  };
  const chain: Record<string, unknown> = {};
  const handler: ProxyHandler<Record<string, unknown>> = {
    get(_target, prop) {
      if (prop === "get") return async () => response;
      if (prop === "post") return async () => writeResponse;
      if (prop === "delete") return async () => ({ getVersion: () => 8 });
      return (...args: unknown[]) => {
        if (prop === "library") libraryCalls.push([String(args[0]), String(args[1])]);
        return new Proxy(chain, handler);
      };
    },
  };
  return { api: new Proxy(chain, handler) as unknown as ZoteroApiInterface, libraryCalls };
}

const USER_ID = "12345";
const GROUP_ID = "777";
const ENV_KEYS = ["ZOTERO_LIBRARY_TYPE", "ZOTERO_LIBRARY_ID", "ZOTERO_USER_ID", "ZOTERO_API_KEY"];

const item = { key: "ITEM0001", version: 3, itemType: "journalArticle", title: "T" };

const toolCases: Array<{ tool: string; args: Record<string, unknown> }> = [
  { tool: "get_collections", args: {} },
  { tool: "get_collection_items", args: { collectionKey: "COLL0001" } },
  { tool: "get_items_details", args: { item_keys: ["ITEM0001"] } },
  { tool: "search_library", args: { query: "x" } },
  { tool: "create_collection", args: { name: "New" } },
  { tool: "add_items", args: { items: [{ itemType: "book", title: "B" }] } },
  { tool: "add_linked_url_attachment", args: { url: "https://example.com/a.pdf" } },
  { tool: "delete_items", args: { item_keys: ["ITEM0001"] } },
  { tool: "delete_collection", args: { collection_key: "COLL0001" } },
];

describe("library routing through tools", () => {
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = {};
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    process.env.ZOTERO_USER_ID = USER_ID;
    process.env.ZOTERO_API_KEY = "test-key";
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    vi.unstubAllGlobals();
  });

  it.each(toolCases)("$tool uses the user library by default", async ({ tool, args }) => {
    const { api, libraryCalls } = createRecordingApi([item], [item]);
    await handleToolCall(tool, args, api, USER_ID, "all");
    expect(libraryCalls.length).toBeGreaterThan(0);
    expect(libraryCalls.every(([t, id]) => t === "user" && id === USER_ID)).toBe(true);
  });

  it.each(toolCases)("$tool uses the group library configured via env", async ({ tool, args }) => {
    process.env.ZOTERO_LIBRARY_TYPE = "group";
    process.env.ZOTERO_LIBRARY_ID = GROUP_ID;
    const { api, libraryCalls } = createRecordingApi([item], [item]);
    // The server passes ZOTERO_LIBRARY_ID as the default library id
    await handleToolCall(tool, args, api, GROUP_ID, "all");
    expect(libraryCalls.length).toBeGreaterThan(0);
    expect(libraryCalls.every(([t, id]) => t === "group" && id === GROUP_ID)).toBe(true);
  });

  it.each(toolCases)("$tool honours a per-call group override", async ({ tool, args }) => {
    const { api, libraryCalls } = createRecordingApi([item], [item]);
    await handleToolCall(tool, { ...args, library_type: "group", library_id: GROUP_ID }, api, USER_ID, "all");
    expect(libraryCalls.length).toBeGreaterThan(0);
    expect(libraryCalls.every(([t, id]) => t === "group" && id === GROUP_ID)).toBe(true);
  });

  it("rejects a per-call group override without library_id instead of reusing the user ID", async () => {
    const { api, libraryCalls } = createRecordingApi([item]);
    await expect(
      handleToolCall("search_library", { query: "x", library_type: "group" }, api, USER_ID)
    ).rejects.toThrow(/library_id is required/);
    expect(libraryCalls).toEqual([]);
  });

  it("switching back to the user library from a group server uses ZOTERO_USER_ID", async () => {
    process.env.ZOTERO_LIBRARY_TYPE = "group";
    process.env.ZOTERO_LIBRARY_ID = GROUP_ID;
    const { api, libraryCalls } = createRecordingApi([item]);
    await handleToolCall("search_library", { query: "x", library_type: "user" }, api, GROUP_ID);
    expect(libraryCalls).toEqual([["user", USER_ID]]);
  });

  it("rejects a non-numeric library_id before any request", async () => {
    const { api, libraryCalls } = createRecordingApi([item]);
    await expect(
      handleToolCall("search_library", { query: "x", library_type: "group", library_id: "../users/1" }, api, USER_ID)
    ).rejects.toThrow();
    expect(libraryCalls).toEqual([]);
  });

  it("get_item_fulltext fetches the fulltext from the group library URL", async () => {
    const attachment = { key: "ATT00001", itemType: "attachment", contentType: "application/pdf" };
    const { api, libraryCalls } = createRecordingApi(attachment);
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ content: "hello" }), { status: 200 })
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await handleToolCall(
      "get_item_fulltext",
      { item_key: "ATT00001", library_type: "group", library_id: GROUP_ID },
      api,
      USER_ID
    );

    expect(libraryCalls).toEqual([["group", GROUP_ID]]);
    expect(fetchMock.mock.calls[0][0]).toBe(`https://api.zotero.org/groups/${GROUP_ID}/items/ATT00001/fulltext`);
    expect(JSON.parse(result.content[0].text as string).text).toBe("hello");
  });

  it("get_user_id reports the group library path and the real user ID", async () => {
    process.env.ZOTERO_LIBRARY_TYPE = "group";
    process.env.ZOTERO_LIBRARY_ID = GROUP_ID;
    const { api } = createRecordingApi();
    const result = await handleToolCall("get_user_id", {}, api, GROUP_ID);
    expect(JSON.parse(result.content[0].text as string)).toEqual({
      user_id: USER_ID,
      library_type: "group",
      library_id: GROUP_ID,
      library_path: `groups/${GROUP_ID}`,
    });
  });
});
