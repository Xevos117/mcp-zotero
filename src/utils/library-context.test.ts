import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getLibraryType, getLibraryId, getDefaultLibrary } from "./library-context.js";

const ENV_KEYS = ["ZOTERO_LIBRARY_TYPE", "ZOTERO_LIBRARY_ID", "ZOTERO_USER_ID"];

describe("library-context", () => {
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = {};
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = saved[k];
      }
    }
  });

  describe("getLibraryType", () => {
    it("defaults to 'user' when ZOTERO_LIBRARY_TYPE is unset", () => {
      expect(getLibraryType()).toBe("user");
    });

    it("returns 'user' when ZOTERO_LIBRARY_TYPE='user'", () => {
      process.env.ZOTERO_LIBRARY_TYPE = "user";
      expect(getLibraryType()).toBe("user");
    });

    it("returns 'group' when ZOTERO_LIBRARY_TYPE='group'", () => {
      process.env.ZOTERO_LIBRARY_TYPE = "group";
      expect(getLibraryType()).toBe("group");
    });

    it("is case-insensitive", () => {
      process.env.ZOTERO_LIBRARY_TYPE = "GROUP";
      expect(getLibraryType()).toBe("group");
    });

    it("throws on invalid values", () => {
      process.env.ZOTERO_LIBRARY_TYPE = "feed";
      expect(() => getLibraryType()).toThrow(/must be 'user' or 'group'/);
    });

    it("treats an empty value as 'user'", () => {
      process.env.ZOTERO_LIBRARY_TYPE = "";
      expect(getLibraryType()).toBe("user");
    });
  });

  describe("getLibraryId", () => {
    it("returns ZOTERO_LIBRARY_ID when set", () => {
      process.env.ZOTERO_LIBRARY_ID = "6178978";
      process.env.ZOTERO_USER_ID = "13885496";
      expect(getLibraryId()).toBe("6178978");
    });

    it("falls back to ZOTERO_USER_ID when ZOTERO_LIBRARY_ID is unset", () => {
      process.env.ZOTERO_USER_ID = "13885496";
      expect(getLibraryId()).toBe("13885496");
    });

    it("returns empty string when neither is set", () => {
      expect(getLibraryId()).toBe("");
    });
  });

  describe("getDefaultLibrary", () => {
    it("returns the user library from ZOTERO_USER_ID", () => {
      process.env.ZOTERO_USER_ID = "13885496";
      expect(getDefaultLibrary()).toEqual({ type: "user", id: "13885496" });
    });

    it("returns the group library from ZOTERO_LIBRARY_ID", () => {
      process.env.ZOTERO_LIBRARY_TYPE = "group";
      process.env.ZOTERO_LIBRARY_ID = "6178978";
      process.env.ZOTERO_USER_ID = "13885496";
      expect(getDefaultLibrary()).toEqual({ type: "group", id: "6178978" });
    });

    it("refuses a group library without ZOTERO_LIBRARY_ID instead of using the user ID", () => {
      process.env.ZOTERO_LIBRARY_TYPE = "group";
      process.env.ZOTERO_USER_ID = "13885496";
      expect(() => getDefaultLibrary()).toThrow(/requires ZOTERO_LIBRARY_ID/);
    });

    it("refuses a missing or non-numeric library id", () => {
      expect(() => getDefaultLibrary()).toThrow(/Missing/);
      process.env.ZOTERO_USER_ID = "me";
      expect(() => getDefaultLibrary()).toThrow(/numeric/);
    });
  });
});

import { resolveLibrary } from "./library-context.js";

describe("resolveLibrary", () => {
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = {};
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = saved[k];
      }
    }
  });

  it("returns env defaults when no args provided", () => {
    process.env.ZOTERO_LIBRARY_TYPE = "group";
    expect(resolveLibrary({}, "13885496")).toEqual({ type: "group", id: "13885496" });
  });

  it("falls back to defaultLibraryId when library_id arg is absent", () => {
    expect(resolveLibrary({}, "424242")).toEqual({ type: "user", id: "424242" });
  });

  it("requires library_id when overriding a user server to a group", () => {
    expect(() => resolveLibrary({ library_type: "group" }, "13885496")).toThrow(/library_id is required/);
  });

  it("falls back to ZOTERO_USER_ID when overriding a group server to the user library", () => {
    process.env.ZOTERO_LIBRARY_TYPE = "group";
    process.env.ZOTERO_USER_ID = "13885496";
    expect(resolveLibrary({ library_type: "user" }, "6178978")).toEqual({ type: "user", id: "13885496" });
  });

  it("rejects non-numeric library ids", () => {
    expect(() => resolveLibrary({ library_id: "123/items" }, "13885496")).toThrow(/numeric/);
  });

  it("per-call arg overrides env", () => {
    process.env.ZOTERO_LIBRARY_TYPE = "user";
    expect(resolveLibrary({ library_type: "group", library_id: "6178978" }, "13885496")).toEqual({
      type: "group",
      id: "6178978",
    });
  });

  it("per-call library_id overrides defaultLibraryId without changing type", () => {
    expect(resolveLibrary({ library_id: "5597114" }, "13885496")).toEqual({
      type: "user",
      id: "5597114",
    });
  });

  it("throws when id is empty (no arg, no default, no env)", () => {
    expect(() => resolveLibrary({}, "")).toThrow(/library ID is not set/);
  });
});
