import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { live, startLive, LiveServer } from "./helpers/live.js";
import { expectUrisResolve } from "./helpers/docx.js";
import { ROOT } from "../e2e/server-process.js";
import { makeDocx, para, zcite, tempDir, TempDir } from "../helpers/fixtures.js";
import { citations, expectValidDocx, CitationStyle } from "../helpers/docx-validate.js";

/**
 * Percorso della skill come lo segue Claude: metadati da get_items_details (MCP reale), library_path da
 * get_user_id, poi inject.js come processo separato. Usa le dipendenze del repo (cwd = ROOT), niente npm install.
 */

const SCRIPT = join(ROOT, "skills", "zotero-skill-mcp-integrations", "scripts", "inject.js");
const SCRIPT_TIMEOUT_MS = 30_000;

function runInject(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((done) => {
    execFile(process.execPath, [SCRIPT, ...args], { cwd: ROOT, timeout: SCRIPT_TIMEOUT_MS, killSignal: "SIGKILL" }, (err, stdout, stderr) => {
      done({ code: err ? (typeof err.code === "number" ? err.code : -1) : 0, stdout, stderr });
    });
  });
}

describe.skipIf(!live.enabled)("skill inject.js (live)", () => {
  let s: LiveServer;
  let dir: TempDir;
  let metadata: string;
  let libraryPath: string;
  beforeAll(async () => {
    s = await startLive();
    dir = await tempDir();
    const f = live.fixtures;
    const details = await s.call("get_items_details", { item_keys: [f.article, f.many, f.book, f.noAuthor] });
    if (details.isError) throw new Error(details.text);
    metadata = await dir.file("metadata.json", JSON.stringify(details.json));
    libraryPath = (await s.call("get_user_id", {})).json.library_path;
  });
  afterAll(async () => {
    await s?.close();
    await dir?.cleanup();
  });

  const body = (numbered: boolean) => {
    const f = live.fixtures;
    const n = (v: string): Record<string, string> => (numbered ? { num: v } : {});
    return para("A ", zcite({ keys: f.article, ...n("1") })) + para("B ", zcite({ keys: `${f.many},${f.book}`, locator: "p. 3", ...n("2,3") })) + para("C ", zcite({ keys: f.noAuthor, ...n("4") }));
  };

  it.each<CitationStyle>(["apa", "ieee"])("LIVE-SK-01 stile %s → docx valido, URI risolvibili, stesso JSON di inject_citations", async (style) => {
    const numbered = style === "ieee";
    const forScript = await dir.file(`skill-${style}.docx`, await makeDocx(body(numbered)));
    const forTool = await dir.file(`tool-${style}.docx`, await makeDocx(body(numbered)));
    const out = join(dir.path, `skill-${style}-out.docx`);
    const r = await runInject([forScript, out, metadata, libraryPath, style]);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stderr).not.toContain("WARNING");
    const report = await expectValidDocx(await readFile(out), { style, libraryPath: live.libraryPath });
    await expectUrisResolve(report);

    const tool = await s.call("inject_citations", { file_path: forTool, style });
    expect(tool.isError, tool.text).toBe(false);
    // publisher-place escluso: inject.js legge publisherPlace mentre get_items_details restituisce place
    // (divergenza nota, SK-09 it.fails in test/skills/inject-script.test.ts)
    const withoutPlace = ({ "publisher-place": _place, ...rest }: Record<string, unknown>) => rest;
    const strip = (xml: string) =>
      citations(xml).map((c) => ({
        text: c.properties.formattedCitation,
        items: c.citationItems.map((ci: any) => ({ uris: ci.uris, itemData: withoutPlace(ci.itemData), locator: ci.locator })),
      }));
    const toolReport = await expectValidDocx(await readFile(tool.json.output_path), { style });
    expect(strip(report.documentXml)).toEqual(strip(toolReport.documentXml));
  });
});
