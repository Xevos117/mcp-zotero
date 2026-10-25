import { describe, it, expect } from "vitest";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";
import { injectCitations } from "../../src/citation-injector/injector.js";
import { tempDir } from "../helpers/fixtures.js";
import { GOLDEN_CASES, fakeZoteroApi, normalizeGolden } from "./golden-fixtures.js";

/**
 * Test golden del percorso Word (regola del proprietario: Word non si tocca, output identico byte per
 * byte). Per ogni fixture IC (più un campione del corpus) inject_citations produce lo stesso
 * word/document.xml e docProps/custom.xml prima e dopo il refactor del nucleo comune, a parte l'id della
 * citazione e l'id di sessione (normalizzati). Gli snapshot in test/fixtures/golden/ sono stati generati
 * dal codice di `main` prima del refactor; rigenerarli con UPDATE_GOLDEN=1 (solo di proposito).
 */

const GOLDEN_DIR = fileURLToPath(new URL("../fixtures/golden/", import.meta.url));
const UPDATE = process.env.UPDATE_GOLDEN === "1";

async function runCase(input: Buffer, style: string, libraryType: "user" | "group", userId: string) {
  const dir = await tempDir();
  try {
    const inputPath = await dir.file("golden.docx", input);
    const result = await injectCitations(inputPath, fakeZoteroApi(), libraryType, userId, style);
    const zip = await JSZip.loadAsync(await readFile(result.outputPath));
    const doc = normalizeGolden(await zip.file("word/document.xml")!.async("string"));
    const customEntry = zip.file("docProps/custom.xml");
    const custom = customEntry ? normalizeGolden(await customEntry.async("string")) : null;
    return { doc, custom };
  } finally {
    await dir.cleanup();
  }
}

describe("golden Word path (PR A: output byte-identico)", () => {
  it("snapshots present (or UPDATE_GOLDEN=1)", () => {
    if (!UPDATE) expect(existsSync(GOLDEN_DIR), `${GOLDEN_DIR} manca: generare con UPDATE_GOLDEN=1`).toBe(true);
  });

  for (const c of GOLDEN_CASES) {
    it(`${c.name}: document.xml e custom.xml identici`, async () => {
      const { doc, custom } = await runCase(await c.input(), c.style, c.libraryType, c.userId);
      const docFile = `${GOLDEN_DIR}${c.name}.document.xml`;
      const customFile = `${GOLDEN_DIR}${c.name}.custom.xml`;
      if (UPDATE) {
        await mkdir(GOLDEN_DIR, { recursive: true });
        await writeFile(docFile, doc);
        if (custom !== null) await writeFile(customFile, custom);
        return;
      }
      expect(doc).toBe(await readFile(docFile, "utf8"));
      if (existsSync(customFile)) {
        expect(custom).toBe(await readFile(customFile, "utf8"));
      } else {
        expect(custom).toBeNull();
      }
    });
  }
});
