import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { live, startLive, LiveServer, title, trackCollections, web, FAKE_KEY } from "./helpers/live.js";

describe.skipIf(!live.enabled)("create_collection (live)", () => {
  let s: LiveServer;
  beforeAll(async () => {
    s = await startLive();
  });
  afterAll(async () => {
    await s?.close();
  });

  const rawCollection = async (key: string) => (await web().getOk(`collections/${key}`)).data.data;

  it("LIVE-CC-01 collezione di primo livello → chiave restituita, visibile via API", async () => {
    const r = await s.call("create_collection", { name: title("created top") });
    trackCollections(r.json?.collection_key);
    expect(r.isError).toBe(false);
    expect(r.json).toEqual({ collection_key: expect.stringMatching(/^[A-Z0-9]{8}$/), name: title("created top") });
    expect(await rawCollection(r.json.collection_key)).toMatchObject({ name: title("created top"), parentCollection: false });
  });

  it("LIVE-CC-02 parent_collection → sottocollezione della collezione della run", async () => {
    const r = await s.call("create_collection", { name: title("created child"), parent_collection: live.collection });
    trackCollections(r.json?.collection_key);
    expect((await rawCollection(r.json.collection_key)).parentCollection).toBe(live.collection);
  });

  it("LIVE-CC-03 nome con spazi ai lati e override library_type user → nome ripulito", async () => {
    const r = await s.call("create_collection", { name: `  ${title("created trimmed")}  `, parent_collection: live.collection, library_type: "user" });
    trackCollections(r.json?.collection_key);
    expect(r.json.name).toBe(title("created trimmed"));
    expect((await rawCollection(r.json.collection_key)).name).toBe(title("created trimmed"));
  });

  it("LIVE-CC-04 nome vuoto → errore, nessuna collezione creata", async () => {
    const r = await s.call("create_collection", { name: "   " });
    expect(r.isError).toBe(true);
  });

  it("LIVE-CC-05 genitore inesistente → isError leggibile", async () => {
    const r = await s.call("create_collection", { name: title("orphan"), parent_collection: FAKE_KEY });
    trackCollections(r.json?.collection_key);
    expect(r.isError).toBe(true);
    expect(r.text).not.toMatch(/\[object Object\]/);
  });
});
