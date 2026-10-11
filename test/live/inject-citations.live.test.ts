import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFile } from "node:fs/promises";
import { live, startLive, LiveServer } from "./helpers/live.js";
import { expectUrisResolve } from "./helpers/docx.js";
import { makeDocx, para, zcite, tempDir, TempDir } from "../helpers/fixtures.js";
import { expectValidDocx, CitationStyle } from "../helpers/docx-validate.js";

describe.skipIf(!live.enabled)("inject_citations (live)", () => {
  let s: LiveServer;
  let dir: TempDir;
  beforeAll(async () => {
    s = await startLive();
    dir = await tempDir();
  });
  afterAll(async () => {
    await s?.close();
    await dir?.cleanup();
  });

  const body = (numbered: boolean) => {
    const f = live.fixtures;
    const n = (v: string): Record<string, string> => (numbered ? { num: v } : {});
    return (
      para("Single ", zcite({ keys: f.article, ...n("1") })) +
      para("Multi ", zcite({ keys: `${f.many},${f.book}`, ...n("2,3") })) +
      para("Locator ", zcite({ keys: f.inSub, locator: "pp. 12-15", prefix: "see ", ...n("4") })) +
      para(`Inline ${zcite({ keys: f.noAuthor, ...n("5") })} in one run.`) +
      para("Repeated ", zcite({ keys: f.article, ...n("1") }))
    );
  };

  it.each<CitationStyle>(["apa", "harvard", "chicago", "ieee", "vancouver"])(
    "LIVE-IC-01 stile %s su voci reali → docx valido (struttura, schema, citeproc) e URI risolvibili via API",
    async (style) => {
      const numbered = style === "ieee" || style === "vancouver";
      const input = await dir.file(`live-${style}.docx`, await makeDocx(body(numbered)));
      const r = await s.call("inject_citations", { file_path: input, style });
      expect(r.isError, r.text).toBe(false);
      expect(r.json).toMatchObject({ citations_found: 5, citations_injected: 5 });
      const report = await expectValidDocx(await readFile(r.json.output_path), { style, libraryPath: live.libraryPath });
      expect(report.rendered!.bibliography).toHaveLength(5);
      await expectUrisResolve(report);
    }
  );

  it("LIVE-IC-02 chiave inesistente → isError (404), nessun output", async () => {
    const input = await dir.file("live-missing.docx", await makeDocx(para(zcite({ keys: "ZZZZZZZZ" }))));
    const r = await s.call("inject_citations", { file_path: input });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/404/);
  });

  it("LIVE-IC-03 override library_type user → stessi URI della libreria utente", async () => {
    const input = await dir.file("live-override.docx", await makeDocx(para(zcite({ keys: live.fixtures.book }))));
    const r = await s.call("inject_citations", { file_path: input, library_type: "user", library_id: live.userId });
    const report = await expectValidDocx(await readFile(r.json.output_path), { libraryPath: live.libraryPath });
    await expectUrisResolve(report);
  });
});
