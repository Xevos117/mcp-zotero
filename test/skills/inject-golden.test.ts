import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFile } from "node:child_process";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";
import { tempDir, TempDir } from "../helpers/fixtures.js";
import { SKILL_GOLDEN_CASES, METADATA, normalizeGolden } from "./inject-golden-fixtures.js";

/**
 * Golden byte-per-byte dello script della skill: lo `inject.js` generato (PR B) produce lo stesso docx
 * dello script scritto a mano (snapshot in test/fixtures/golden-skill/, catturati prima del refactor).
 * `UPDATE_SKILL_GOLDEN=1` rigenera gli snapshot (solo di proposito).
 */

const ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const SCRIPT = join(ROOT, "skills", "zotero-skill-mcp-integrations", "scripts", "inject.js");
const GOLDEN_DIR = join(ROOT, "test", "fixtures", "golden-skill") + "/";
const UPDATE = process.env.UPDATE_SKILL_GOLDEN === "1";

function run(args: string[]): Promise<{ code: number; stderr: string }> {
  return new Promise((done) => {
    execFile(process.execPath, [SCRIPT, ...args], { cwd: ROOT, timeout: 20_000, killSignal: "SIGKILL" }, (err, _out, stderr) => {
      done({ code: err ? (typeof err.code === "number" ? err.code : -1) : 0, stderr });
    });
  });
}

describe("skill inject.js golden (byte-identico allo script di oggi)", () => {
  let dir: TempDir;
  let metaPath: string;
  beforeAll(async () => {
    dir = await tempDir();
    metaPath = await dir.file("metadata.json", JSON.stringify(METADATA));
  });
  afterAll(async () => {
    await dir?.cleanup();
  });

  for (const c of SKILL_GOLDEN_CASES) {
    it(`${c.name}: document.xml e custom.xml identici`, async () => {
      const inPath = await dir.file(`${c.name}.docx`, await c.input());
      const outPath = join(dir.path, `${c.name}_out.docx`);
      const r = await run([inPath, outPath, metaPath, c.library, c.style]);
      expect(r.code, r.stderr).toBe(0);
      const zip = await JSZip.loadAsync(await readFile(outPath));
      const doc = normalizeGolden(await zip.file("word/document.xml")!.async("string"));
      const customEntry = zip.file("docProps/custom.xml");
      const custom = customEntry ? normalizeGolden(await customEntry.async("string")) : null;
      const docFile = `${GOLDEN_DIR}${c.name}.document.xml`;
      const customFile = `${GOLDEN_DIR}${c.name}.custom.xml`;
      if (UPDATE) {
        await mkdir(GOLDEN_DIR, { recursive: true });
        await writeFile(docFile, doc);
        if (custom !== null) await writeFile(customFile, custom);
        return;
      }
      expect(doc).toBe(await readFile(docFile, "utf8"));
      if (existsSync(customFile)) expect(custom).toBe(await readFile(customFile, "utf8"));
      else expect(custom).toBeNull();
    });
  }
});
