import { expect } from "vitest";
import { citations, DocxReport } from "../../helpers/docx-validate.js";
import { web } from "./live.js";

/**
 * Ogni URI dei campi deve risolvere via Web API sulla voce giusta: stessa chiave, stesso titolo
 * dell'itemData incorporato. Così un URI ben formato ma sbagliato (libreria o chiave) viene scoperto.
 */
export async function expectUrisResolve(report: DocxReport): Promise<void> {
  const seen = new Map<string, string | undefined>();
  for (const c of citations(report.documentXml)) {
    for (const ci of c.citationItems) seen.set(ci.uris[0], ci.itemData?.title);
  }
  expect(seen.size).toBeGreaterThan(0);
  for (const [uri, itemTitle] of seen) {
    const m = /^http:\/\/zotero\.org\/((?:users|groups)\/\d+)\/items\/([A-Z0-9]{8})$/.exec(uri);
    expect(m, uri).not.toBeNull();
    const r = await web().withLibrary(m![1]).get(`items/${m![2]}`);
    expect(r.status, uri).toBe(200);
    expect(r.data.data.title, uri).toBe(itemTitle);
  }
}
