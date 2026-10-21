// Path A against path B: the bibliography Zotero rendered from the itemData embedded by the product (path B) against
// the one rendered from the same items in the local library (path A), entry by entry. Every difference is data that
// the product's itemData loses or changes. JSON on stdout, a Markdown list in $GITHUB_STEP_SUMMARY when set.
// With --expect, expect.json `ab.differences` lists the expected differing entries (a substring of the library
// entry each); exit 1 if the differences are not exactly those.
// Usage: node compare.mjs <reportB.json> <stepB> <reportA.json> <stepA> [--expect expect.json]
import { readFile, appendFile } from "node:fs/promises";

const argv = process.argv.slice(2);
const ei = argv.indexOf("--expect");
const expected = ei >= 0 ? (JSON.parse(await readFile(argv[ei + 1], "utf8")).ab?.differences ?? []) : null;
const [reportB, stepB, reportA, stepA] = argv.filter((_, i) => ei < 0 || (i !== ei && i !== ei + 1));
const b = JSON.parse(await readFile(reportB, "utf8")).steps[stepB]?.bibliography ?? [];
const a = JSON.parse(await readFile(reportA, "utf8")).steps[stepA]?.bibliography ?? [];

const differences = [];
for (let i = 0; i < Math.max(a.length, b.length); i++) {
  if (a[i] !== b[i]) differences.push({ entry: i + 1, library: a[i] ?? null, embedded: b[i] ?? null });
}
const problems = [];
if (a.length === 0 || b.length === 0) problems.push(`no bibliography to compare (library ${a.length}, embedded ${b.length})`);
if (expected) {
  const unexpected = differences.filter((d) => !expected.some((s) => (d.library ?? "").includes(s)));
  const gone = expected.filter((s) => !differences.some((d) => (d.library ?? "").includes(s)));
  for (const d of unexpected) problems.push(`unexpected difference in entry ${d.entry}: library "${d.library}" / embedded "${d.embedded}"`);
  for (const s of gone) problems.push(`expected difference "${s}" not found: remove it from expect.json ab.differences`);
}
console.log(JSON.stringify({ stepA, stepB, entries: a.length, differences, problems }, null, 2));
if (process.env.GITHUB_STEP_SUMMARY) {
  const cell = (s) => String(s ?? "—").replace(/\n/g, " ");
  await appendFile(
    process.env.GITHUB_STEP_SUMMARY,
    [
      `### word-proxy: libreria locale (${stepA}) contro itemData incorporato (${stepB})`,
      "",
      differences.length ? `${differences.length} voci su ${a.length} diverse:` : `Nessuna differenza nelle ${a.length} voci.`,
      "",
      ...differences.map((d) => `- voce ${d.entry}\n  - libreria: ${cell(d.library)}\n  - itemData: ${cell(d.embedded)}`),
      ...problems.map((p) => `- **${p}**`),
      "",
    ].join("\n")
  );
}
for (const p of problems) console.error(`word-proxy ab: ${p}`);
if (problems.length) process.exitCode = 1;
