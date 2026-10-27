import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { live, startLive, LiveServer, createCollection, createItems, title } from "./helpers/live.js";

/**
 * find_duplicates dal vivo: tutte le voci sono create dalla run in collezioni dedicate, così i gruppi sono
 * deterministici e la pulizia globale (tag della run) le rimuove. Il tool è di sola lettura e non tocca
 * servizi esterni, quindi i casi non sono `soft`.
 */
const SHARED_DOI = "10.9999/mzt-fd-shared";
const ABSENT_DOI = "10.9999/mzt-fd-absent-xyz";

describe.skipIf(!live.enabled)("find_duplicates (live)", () => {
  let s: LiveServer;
  let coll: string;
  let cleanColl: string;
  let doiA: string;
  let doiB: string;
  let titA: string;
  let titB: string;
  let uniq: string;

  beforeAll(async () => {
    s = await startLive();
    coll = await createCollection("find duplicates");
    cleanColl = await createCollection("find duplicates clean");
    [doiA, doiB, titA, titB, uniq] = await createItems([
      { itemType: "journalArticle", title: title("FD DOI dup A"), DOI: SHARED_DOI, date: "2020", collections: [coll] },
      { itemType: "journalArticle", title: title("FD DOI dup B"), DOI: SHARED_DOI, date: "2021", collections: [coll] },
      { itemType: "journalArticle", title: title("FD Café Métabolisme Review!"), DOI: "10.9999/mzt-fd-t1", date: "2019", collections: [coll] },
      { itemType: "journalArticle", title: title("FD Cafe Metabolisme Review"), DOI: "10.9999/mzt-fd-t2", date: "2019", collections: [coll] },
      { itemType: "journalArticle", title: title("FD Totally Unique Entry"), DOI: "10.9999/mzt-fd-u", date: "2018", collections: [coll] },
    ]);
    // Una nota e un allegato standalone nella collezione: devono essere ignorati dallo scan.
    await createItems([
      { itemType: "note", note: `<p>${title("FD note")}</p>`, collections: [coll] },
      { itemType: "attachment", linkMode: "linked_url", title: title("FD link"), url: "https://example.org/mzt-fd", collections: [coll] },
    ]);
    // La collezione "clean" contiene una sola voce: nessun duplicato.
    await createItems([{ itemType: "journalArticle", title: title("FD Clean Unique"), DOI: "10.9999/mzt-fd-clean", date: "2017", collections: [cleanColl] }]);
  });
  afterAll(async () => {
    await s?.close();
  });

  const keysOf = (items: Array<{ key: string }>) => items.map((i) => i.key).sort();

  it("LIVE-FD-01 scan della collezione: gruppi per DOI e per titolo, note/allegati esclusi", async () => {
    const r = await s.call("find_duplicates", { collection_key: coll });
    expect(r.isError, r.text).toBe(false);
    expect(r.json.mode).toBe("scan");
    expect(r.json.scanned).toBe(5); // 5 voci regolari; nota e allegato esclusi
    expect(r.json.truncated).toBe(false);
    expect(r.json.duplicate_groups).toBe(2);

    const doiGroup = r.json.groups.find((g: { match: string }) => g.match === "doi");
    expect(doiGroup.key).toBe(SHARED_DOI);
    expect(keysOf(doiGroup.items)).toEqual([doiA, doiB].sort());

    const titleGroup = r.json.groups.find((g: { match: string }) => g.match === "title");
    expect(keysOf(titleGroup.items)).toEqual([titA, titB].sort());

    // La voce unica non compare in nessun gruppo
    const allGrouped = r.json.groups.flatMap((g: { items: Array<{ key: string }> }) => g.items.map((i) => i.key));
    expect(allGrouped).not.toContain(uniq);
  });

  it("LIVE-FD-02 modo dois: DOI presente trovato (forma URL), DOI assente con existing vuoto", async () => {
    const r = await s.call("find_duplicates", { collection_key: coll, dois: [`https://doi.org/${SHARED_DOI.toUpperCase()}`, ABSENT_DOI] });
    expect(r.isError, r.text).toBe(false);
    expect(r.json.mode).toBe("dois");
    expect(r.json.dois[0]).toMatchObject({ normalized: SHARED_DOI });
    expect(keysOf(r.json.dois[0].existing)).toEqual([doiA, doiB].sort());
    expect(r.json.dois[1]).toMatchObject({ doi: ABSENT_DOI, normalized: ABSENT_DOI, existing: [] });
  });

  it("LIVE-FD-03 collezione senza duplicati → nessun gruppo", async () => {
    const r = await s.call("find_duplicates", { collection_key: cleanColl });
    expect(r.isError, r.text).toBe(false);
    expect(r.json).toMatchObject({ mode: "scan", scanned: 1, duplicate_groups: 0, groups: [] });
  });

  it("LIVE-FD-04 override library_type user", async () => {
    const r = await s.call("find_duplicates", { collection_key: coll, library_type: "user" });
    expect(r.isError, r.text).toBe(false);
    expect(r.json.duplicate_groups).toBe(2);
  });
});
