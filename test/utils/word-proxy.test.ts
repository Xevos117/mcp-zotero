import { describe, it, expect, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";
// @ts-expect-error plain .mjs script without type declarations
import { artifactProblems } from "../../test/word-proxy/check-artifacts.mjs";
// @ts-expect-error plain .mjs script without type declarations
import { itemDataItems } from "../../test/word-proxy/render.mjs";
import { readFileSync } from "node:fs";

/** Scripts of the word-proxy job (test/word-proxy/), on documents built here: no Zotero, no WordCraft. */

const ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const WP = join(ROOT, "test", "word-proxy");
const SENTINEL = "word-proxy-secret-sentinel";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function temp(): string {
  const d = mkdtempSync(join(tmpdir(), "mcp-zotero-word-proxy-"));
  dirs.push(d);
  return d;
}

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const field = (code: string, visible: string) =>
  `<w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve">${code
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/"/g, "&quot;")}</w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>${visible}</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>`;
const citation = (key: string, id: number, visible: string) =>
  field(
    `ADDIN ZOTERO_ITEM CSL_CITATION ${JSON.stringify({
      citationID: `c${id}`,
      properties: { formattedCitation: visible, noteIndex: 0 },
      citationItems: [{ id, uris: [`http://zotero.org/users/000000/items/${key}`] }],
    })}`,
    visible
  );
const bibEntry = (t: string) => `<w:p><w:pPr><w:pStyle w:val="Bibliography"/></w:pPr><w:r><w:t>${t}</w:t></w:r></w:p>`;

/** A document as Zotero leaves it after a Refresh (2 citations, 2 entries, prefs with the style). */
async function refreshed(opts: { style?: string; bibliography?: string[] } = {}): Promise<Buffer> {
  const zip = new JSZip();
  const body =
    citation("AAAA2222", 1, "(Rossi, 2020)") +
    citation("BBBB3333", 2, "(see Bianchi, 2018, p. 12)") +
    field("ADDIN ZOTERO_BIBL {} CSL_BIBLIOGRAPHY", "") +
    (opts.bibliography ?? ["Bianchi, A. (2018). Beta.", "Rossi, M. (2020). Alpha."]).map(bibEntry).join("");
  zip.file("word/document.xml", `<?xml version="1.0"?><w:document ${W}><w:body>${body}</w:body></w:document>`);
  const style = opts.style ?? "http://www.zotero.org/styles/apa";
  zip.file(
    "docProps/custom.xml",
    `<Properties><property name="ZOTERO_PREF_1"><vt:lpwstr>&lt;data&gt;&lt;style id=&quot;${style}&quot;/&gt;&lt;/data&gt;</vt:lpwstr></property></Properties>`
  );
  return zip.generateAsync({ type: "nodebuffer" });
}

function session(dir: string, steps: Record<string, Buffer>, events: object[]): void {
  mkdirSync(dir, { recursive: true });
  for (const [step, docx] of Object.entries(steps)) {
    writeFileSync(join(dir, `${step}.refreshed.docx`), docx);
    writeFileSync(join(dir, `${step}.trace`), "→ Application_getActiveDocument\n← ok\n12 calls, completed\n");
  }
  writeFileSync(join(dir, "events.jsonl"), events.map((e) => JSON.stringify(e)).join("\n") + "\n");
}

function run(script: string, args: string[]): { code: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(process.execPath, [join(WP, script), ...args], { env: { PATH: process.env.PATH ?? "" }, timeout: 20_000, stdio: "pipe" }).toString();
    return { code: 0, stdout, stderr: "" };
  } catch (e) {
    const err = e as { status: number; stdout: Buffer; stderr: Buffer };
    return { code: err.status, stdout: err.stdout.toString(), stderr: err.stderr.toString() };
  }
}

describe("word-proxy: verify.mjs e compare.mjs (WP-V)", () => {
  const EVENTS = [
    { ready: true, zotero: "10.0.6" },
    { step: "first" },
    { dialog: "chrome://zotero/content/integration/integrationDocPrefs.xhtml", proposedStyle: "http://www.zotero.org/styles/chicago-shortened-notes-bibliography" },
    { answer: "http://www.zotero.org/styles/apa" },
    { embedded: "http://zotero.org/users/000000/items/AAAA2222" },
    { embedded: "http://zotero.org/users/000000/items/BBBB3333" },
    { step: "second" },
  ];
  const EXPECT = {
    _all: { alerts: 0, noteIndex: 0, oneIdPerUri: true, citations: 2, bibliographyEntries: 2, uriPrefix: "http://zotero.org/users/000000/items/" },
    first: { knownBug: "H-W1", docPrefsDialog: true, styleInDoc: "http://www.zotero.org/styles/apa", embeddedFallback: "all", visibleIncludes: ["p. 12"] },
    second: { docPrefsDialog: false, embeddedFallback: [], bibliographyIncludes: ["Rossi, M. (2020)"] },
    ab: { differences: ["Rossi, M. (2020). Alpha."] },
  };

  it("WP-V01 aspettative rispettate → exit 0; dialogo, risposta, fallback e testo letti dal passo giusto", async () => {
    const d = temp();
    session(d, { first: await refreshed(), second: await refreshed() }, EVENTS);
    writeFileSync(join(d, "expect.json"), JSON.stringify(EXPECT));
    const r = run("verify.mjs", [d, "--expect", join(d, "expect.json"), "first", "second"]);
    expect(r.stderr).toBe("");
    expect(r.code).toBe(0);
    const report = JSON.parse(r.stdout);
    expect(report.steps.first).toMatchObject({ docPrefsDialog: true, docPrefsAnswer: "http://www.zotero.org/styles/apa", embeddedFallback: ["AAAA2222", "BBBB3333"] });
    expect(report.steps.second).toMatchObject({ docPrefsDialog: false, embeddedFallback: [] });
  });

  it("WP-V02 una differenza → exit 1 con atteso/ottenuto; passo senza aspettative → errore", async () => {
    const d = temp();
    session(d, { first: await refreshed({ style: "http://www.zotero.org/styles/ieee" }), second: await refreshed() }, EVENTS);
    writeFileSync(join(d, "expect.json"), JSON.stringify({ ...EXPECT, second: undefined }));
    const r = run("verify.mjs", [d, "--expect", join(d, "expect.json"), "first", "second"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('word-proxy first: styleInDoc: expected "http://www.zotero.org/styles/apa", got "http://www.zotero.org/styles/ieee"');
    expect(r.stderr).toContain("no expectations for step second");
  });

  it("WP-V03 compare.mjs: differenze A/B attese → exit 0; nuova o sparita → exit 1", async () => {
    const d = temp();
    session(join(d, "b"), { first: await refreshed({ bibliography: ["Bianchi, A. (2018). Beta.", "Rossi, M. (2020)."] }) }, EVENTS);
    session(join(d, "a"), { second: await refreshed() }, EVENTS);
    writeFileSync(join(d, "expect.json"), JSON.stringify(EXPECT));
    expect(run("verify.mjs", [join(d, "b"), "first"]).code).toBe(0);
    writeFileSync(join(d, "b.json"), run("verify.mjs", [join(d, "b"), "first"]).stdout);
    writeFileSync(join(d, "a.json"), run("verify.mjs", [join(d, "a"), "second"]).stdout);
    const ok = run("compare.mjs", [join(d, "b.json"), "first", join(d, "a.json"), "second", "--expect", join(d, "expect.json")]);
    expect(ok.code).toBe(0);
    expect(JSON.parse(ok.stdout).differences).toHaveLength(1);
    writeFileSync(join(d, "expect.json"), JSON.stringify({ ab: { differences: ["Bianchi"] } }));
    const bad = run("compare.mjs", [join(d, "b.json"), "first", join(d, "a.json"), "second", "--expect", join(d, "expect.json")]);
    expect(bad.code).toBe(1);
    expect(bad.stderr).toContain("unexpected difference in entry 2");
    expect(bad.stderr).toContain('expected difference "Bianchi" not found');
  });

  it("WP-V04 la sessione fallisce con un errore di setup, una voce mancante o un caricamento incompleto", async () => {
    const d = temp();
    session(d, { first: await refreshed() }, [...EVENTS, { setupError: "boom" }, { missingItem: true }, { loaded: 3, library: "user" }]);
    const r = run("verify.mjs", [d, "first"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("setup error: boom");
    expect(r.stderr).toContain("Zotero asked for a missing item");
    expect(r.stderr).toMatch(/load-items: 3 items in the user library, expected \d+/);
  });
});

describe("word-proxy: check-artifacts.mjs (WP-CA)", () => {
  it("WP-CA01 artifact con soli dati segnaposto e del corpus → pulito", async () => {
    const d = temp();
    writeFileSync(join(d, "a.refreshed.docx"), await refreshed());
    writeFileSync(join(d, "a.trace"), "path /home/runner/work/x http://zotero.org/groups/777/items/AAAA2222\n");
    writeFileSync(join(d, "report.json"), "{}");
    expect(await artifactProblems([d], [SENTINEL])).toEqual([]);
  });

  it("WP-CA02 URI di un'altra libreria (anche dentro un docx), email, home, valore segreto, file inatteso → segnalati", async () => {
    const d = temp();
    const zip = new JSZip();
    zip.file("word/document.xml", "<w:t>http://zotero.org/users/1234567/items/AAAA2222</w:t>");
    writeFileSync(join(d, "x.refreshed.docx"), await zip.generateAsync({ type: "nodebuffer" }));
    writeFileSync(join(d, "a.trace"), `contact someone@example.org at /home/alice/x and ${SENTINEL}\n`);
    writeFileSync(join(d, "zotero.log"), "debug");
    const problems = (await artifactProblems([d], [SENTINEL])).join("\n");
    expect(problems).toContain("x.refreshed.docx: library URI other than the placeholders (users/…)");
    expect(problems).toContain("a.trace: email address");
    expect(problems).toContain("a.trace: home directory other than the runner's");
    expect(problems).toContain("a.trace: value of a secret-like environment variable");
    expect(problems).toContain("zotero.log: unexpected file type");
    expect(problems).not.toContain("1234567");
  });
});

describe("word-proxy: render.mjs (WP-R)", () => {
  it("WP-R01 ogni differenza itemData nota di expect.json ha la sua voce del corpus (dalla voce di bibliografia di libreria che la contiene)", () => {
    const read = (rel: string) => JSON.parse(readFileSync(join(ROOT, rel), "utf8"));
    const expectJson = read("test/word-proxy/expect.json");
    // APA bibliography of path A as Zotero rendered it (word-proxy run)
    const bibliography = [
      "Gualandi, B. (2022). What do we mean by “data” in the arts and humanities? Final Dissertation in Open Science [University of Bologna]. https://doi.org/10.5281/zenodo.6385132",
      "Jiang, A. Q., Sablayrolles, A., … El Sayed, W. (2023). Mistral 7B (arXiv:2310.06825). arXiv. https://doi.org/10.48550/arXiv.2310.06825",
      "Research Data Alliance FAIR Data Maturity Model Working Group. (2020). FAIR Data Maturity Model: Specification and guidelines. Research Data Alliance. https://doi.org/10.15497/rda00050",
      "The Turing Way Community. (n.d.). Guide for Reproducible Research. The Turing Way. Retrieved October 21, 2026, from https://book.the-turing-way.org/reproducible-research/reproducible-research",
    ];
    const entries = itemDataItems(expectJson.ab.differences, bibliography, read("test/fixtures/corpus/library.json"), read("test/fixtures/corpus/corpus.json"));
    expect(entries.map((e: { item: string }) => e.item)).toEqual(["gualandi2022", "jiang2023", "rda2020", "turingway"]);
    expect(() => itemDataItems(["nowhere"], bibliography, read("test/fixtures/corpus/library.json"), read("test/fixtures/corpus/corpus.json"))).toThrow(/no corpus item/);
  });
});
