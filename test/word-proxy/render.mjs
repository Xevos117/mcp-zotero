// Renders the documents Zotero refreshed in a word-proxy run (ci.sh output) to PNG pages with wordcraft-cli, for the
// visual review of the agent smoke test (job word-render of claude-agent-smoke.yml), and writes index.json: which
// document, style, path (A: library, B: embedded itemData) and page each image is, the Document Preferences dialog
// recorded at that step, the corpus items cited, and the known issues (from expect.json) the reviewer may meet.
// Rendering is WordCraft's, not Word's: content is meaningful, layout is not.
// Usage: node test/word-proxy/render.mjs <ci.sh outdir> <wordcraft-cli> <destdir>
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Steps rendered: every style from embedded data (path B), the H-W1 "proposed" case, the group, path A. */
export const RENDERED = [
  { session: "embedded", step: "apa" },
  { session: "embedded", step: "ieee" },
  { session: "embedded", step: "vancouver" },
  { session: "embedded", step: "harvard" },
  { session: "embedded", step: "chicago" },
  { session: "embedded", step: "proposed" },
  { session: "embedded", step: "group" },
  { session: "library", step: "lib-fix-apa" },
];
const SCALE = "1.5";
/** What the pages show that is not a product bug (the style or the corpus data does it; Zotero does the same in Word). */
const RENDERING_NOTES = [
  {
    id: "nlm-locator",
    steps: ["vancouver"],
    // the only cited item with a locator: the note covers nothing else on that document
    items: ["eve2020"],
    description: 'NLM citation-sequence (vancouver) prints no locator in the citation: "(see 4)" for locator 110 is the style, not a lost locator',
  },
  {
    id: "no-language",
    steps: RENDERED.map((r) => r.step),
    items: ["ivanov2022"],
    description:
      "ivanov2022 has no language field (the registry gives none): citeproc applies English title case to its Cyrillic title in the styles that use title case (e.g. Chicago); Zotero does the same in Word",
  },
];
const corpusFile = new URL("../fixtures/corpus/corpus.json", import.meta.url);
const libraryFile = new URL("../fixtures/corpus/library.json", import.meta.url);
const expectFile = new URL("./expect.json", import.meta.url);

/** Corpus item of each known itemData difference: the library entry containing its text, the item whose title it has. */
export function itemDataItems(differences, bibliography, library, manifest) {
  const idByKey = Object.fromEntries(manifest.works.map((w) => [w.key, w.id]));
  const norm = (t) => t.toLowerCase().replace(/[“”"‘’']/g, "");
  return differences.map((text) => {
    const entry = bibliography.find((b) => b.includes(text)) ?? "";
    const item = library.items.find((i) => norm(entry).includes(norm(String(i.title)).slice(0, 15)));
    if (!item) throw new Error(`render: no corpus item for the itemData difference "${text}"`);
    return { text, item: idByKey[item.key] };
  });
}

function events(dir) {
  return readFileSync(join(dir, "events.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

/** The plugin's dialog events of one step (between its marker and the next). */
function dialogOf(evts, step) {
  const start = evts.findIndex((e) => e.step === step);
  const end = evts.findIndex((e, i) => i > start && e.step);
  const seg = start < 0 ? [] : evts.slice(start + 1, end < 0 ? undefined : end);
  const d = seg.find((e) => /integrationDocPrefs/.test(e.dialog ?? ""));
  return d ? { title: "Document Preferences", proposedStyle: d.proposedStyle, answer: seg.find((e) => e.answer)?.answer } : null;
}

if (process.argv[1] && process.argv[1].endsWith("render.mjs")) {
  const [out, wordcraft, dest] = process.argv.slice(2);
  if (!out || !wordcraft || !dest) {
    console.error("usage: render.mjs <ci.sh outdir> <wordcraft-cli> <destdir>");
    process.exit(2);
  }
  mkdirSync(dest, { recursive: true });
  const manifest = JSON.parse(readFileSync(corpusFile, "utf8"));
  const expect = JSON.parse(readFileSync(expectFile, "utf8"));
  const env = { ...process.env, WORDCRAFT_REGION: "en-US" };
  const run = (args) => execFileSync(wordcraft, args, { env, timeout: 60_000, encoding: "utf8" });
  const library = JSON.parse(readFileSync(libraryFile, "utf8"));
  const images = [];
  const evtsBySession = {};
  for (const { session, step } of RENDERED) {
    const dir = join(out, session);
    const evts = (evtsBySession[session] ??= events(dir));
    const docx = join(dir, `${step}.refreshed.docx`);
    const pages = JSON.parse(run(["info", docx])).pages;
    const style = JSON.parse(readFileSync(join(dir, "report.json"), "utf8")).steps[step]?.styleInDoc ?? null;
    for (let page = 1; page <= pages; page++) {
      const image = `${step}-p${page}.png`;
      run(["render", docx, join(dest, image), "--page", String(page), "--scale", SCALE]);
      images.push({
        image,
        document: step,
        path: session === "library" ? "A (library items)" : "B (itemData embedded by the product)",
        style,
        page,
        pages,
        dialog: dialogOf(evts, step),
        knownBug: expect[step]?.knownBug ?? null,
      });
    }
  }
  // The known itemData differences (expect.json ab.differences: text of the library entry) with their corpus item: the
  // library entry (path A) that contains the text, and the corpus item whose title starts that entry's title part
  const pathA = RENDERED.find((r) => r.session === "library");
  const libraryBibliography = JSON.parse(readFileSync(join(out, pathA.session, "report.json"), "utf8")).steps[pathA.step]?.bibliography ?? [];
  const itemDataEntries = itemDataItems(expect.ab.differences, libraryBibliography, library, manifest);
  const index = {
    description:
      "Pages of the documents Zotero 10 refreshed in word-proxy, rendered by WordCraft (not Word): judge the content of citations and bibliography, not the layout.",
    documents: "Every document cites the same 12 corpus items: Single, Same first author and year, Locator and prefix (locator 110, prefix see), Repeated, Edited book and monograph, Cyrillic, Preprint/thesis/report/web page, Same single author and year; then References.",
    corpus: manifest.works.map((w) => ({ id: w.id, key: w.key, itemType: w.itemType, cases: w.cases })),
    knownIssues: [
      { id: "H-W1", steps: RENDERED.map((r) => r.step).filter((s) => expect[s]?.knownBug === "H-W1"), description: expect.apa.why, requiresDialog: true },
      // reportsRequired: the reviewer must report each of these (evidence that the pages were really reviewed)
      { id: "itemData", steps: ["apa", "ieee", "vancouver", "harvard", "chicago", "group"], description: expect.ab.why, entries: itemDataEntries, items: itemDataEntries.map((e) => e.item), reportsRequired: true },
      ...RENDERING_NOTES,
    ],
    images,
  };
  writeFileSync(join(dest, "index.json"), JSON.stringify(index, null, 2) + "\n");
  console.log(`render: ${images.length} pages from ${RENDERED.length} documents → ${dest}`);
}
