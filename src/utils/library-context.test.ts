import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getLibraryType, getLibraryId } from "./library-context.js";

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
    expect(resolveLibrary({}, "user-fallback")).toEqual({ type: "user", id: "user-fallback" });
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
