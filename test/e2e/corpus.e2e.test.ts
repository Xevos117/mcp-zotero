import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startFakeNetServer, FakeNetServer } from "./fake-net-server.js";
import { SERVER, Spawned, spawnServer, call } from "./server-process.js";
import { USER_ID, ZBASE, ZItem, zWrite } from "../helpers/zotero-fake.js";
import { makeDocx, para, zcite } from "../helpers/fixtures.js";
import { expectValidDocx } from "../helpers/docx-validate.js";
import { corpusItem, corpusRoutes, corpusWork, serveCorpusLibrary } from "../helpers/corpus.js";

/**
 * E2E on the real corpus (test/fixtures/corpus/): the built server over stdio, its fetch redirected to the
 * FakeNet that replays the recorded doi.org responses and serves the curated library.
 */

describe("e2e: corpus reale", () => {
  let fake: FakeNetServer;
  let cwd: string;
  let s: Spawned;

  beforeAll(async () => {
    if (!existsSync(SERVER)) throw new Error(`${SERVER} non trovato: eseguire prima "npm run build"`);
    fake = await startFakeNetServer();
    corpusRoutes(fake.net);
    serveCorpusLibrary(fake.net);
    fake.net.on("POST", `${ZBASE}/items`, zWrite());
    cwd = await mkdtemp(join(tmpdir(), "mcp-zotero-e2e-corpus-"));
    s = await spawnServer(fake, cwd, {});
  });

  afterAll(async () => {
    await s?.close();
    await fake?.close();
    if (cwd) await rm(cwd, { recursive: true, force: true });
  });

  it("E2E-C01 add_items_by_doi: DOI Crossref (cirillico) e DataCite (arXiv) dalle cassette, titoli e autori intatti", async () => {
    const ids = ["ivanov2022", "jiang2023"];
    const out = await call(s, "add_items_by_doi", { dois: ids.map((id) => corpusWork(id).sources.doi) });
    expect(out.isError, out.text).toBe(false);
    const created = fake.net.requests("POST", `${ZBASE}/items`).flatMap((r) => r.json<ZItem[]>());
    for (const id of ids) {
      const curated = corpusItem(id);
      const item = created.find((i) => i.title === curated.title);
      expect(item, id).toBeDefined();
      expect((item!.creators as unknown[]).length).toBe((curated.creators as unknown[]).length);
    }
    expect(fake.net.unmatched).toEqual([]);
  });

  it("E2E-C02 inject_citations apa sulla libreria curata: docx valido, una voce per opera", async () => {
    const keys = ["conneau2020", "ivanov2022", "eve2020", "turingway"].map((id) => corpusWork(id).key);
    const input = join(cwd, "corpus.docx");
    await writeFile(input, await makeDocx(para("Corpus ", zcite({ keys: keys.join(",") })) + para("Again ", zcite({ keys: keys[0] }))));
    const out = await call(s, "inject_citations", { file_path: input, style: "apa" });
    expect(out.isError, out.text).toBe(false);
    const r = await expectValidDocx(await readFile(out.json.output_path), { style: "apa", libraryPath: `users/${USER_ID}` });
    expect(r.rendered!.bibliography).toHaveLength(4);
    expect(fake.net.unmatched).toEqual([]);
  });
});
