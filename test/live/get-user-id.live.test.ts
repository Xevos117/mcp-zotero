import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { live, startLive, LiveServer } from "./helpers/live.js";

describe.skipIf(!live.enabled)("get_user_id (live)", () => {
  let s: LiveServer;
  beforeAll(async () => {
    s = await startLive();
  });
  afterAll(async () => {
    await s?.close();
  });

  it("LIVE-GUI-01 libreria utente della chiave", async () => {
    const r = await s.call("get_user_id", {});
    expect(r.isError).toBe(false);
    expect(r.json).toEqual({ user_id: live.userId, library_type: "user", library_id: live.userId, library_path: live.libraryPath });
  });

  it("LIVE-GUI-02 tools/call senza arguments e con argomenti in più", async () => {
    expect((await s.call("get_user_id", undefined)).json?.user_id).toBe(live.userId);
    expect((await s.call("get_user_id", { foo: 1 })).json?.user_id).toBe(live.userId);
  });

  it("LIVE-GUI-03 tools/list: 16 tool", async () => {
    expect((await s.listTools()).length).toBe(16);
  });
});
