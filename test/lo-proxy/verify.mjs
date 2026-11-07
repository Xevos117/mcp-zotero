// Reads one lo-proxy session directory (refreshed .odt files, driver logs, events.jsonl written by run.sh) and
// reports, per step, what Zotero did with the injected ODF document: reference-mark citations (their CSL_CITATION
// JSON), the visible rendered text, the ZOTERO_BIBL bibliography section and its entries, the ZOTERO_PREF document
// preferences (style, fieldType), alerts and embedded-data fallbacks. JSON on stdout, a Markdown table in
// $GITHUB_STEP_SUMMARY when set. With --expect <word-proxy/expect.json> every step is checked against the SAME
// visible/bibliography expectations as the Word path (the rendering is Zotero's, identical in both), plus the ODF
// structure (one bibliography section, the Bibliography_20_1 style, fieldType ReferenceMark); exit 1 on any
// mismatch. Without it, exit 1 only when a command did not complete. Every session also fails on a setup error, a
// prompt for a missing item, a load-items.js run that did not load the whole corpus, or any alert.
// Usage: node verify.mjs <sessiondir> [--expect word-proxy/expect.json] <step>...
import { readFile, appendFile } from "node:fs/promises";
import { join } from "node:path";
import JSZip from "jszip";

const dec = (s) => s.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
const stripTags = (xml) => xml.replace(/<[^>]+>/g, "");

/**
 * Visible text of the body paragraphs (citations as Zotero rendered them, with the surrounding words), without the
 * ZOTERO_BIBL section. The rendered citation sits between the reference-mark-start/end tags inside a paragraph, so
 * the paragraph text carries both the label and the citation (e.g. "Repeated [1]."): the same shape as word-proxy's
 * per-paragraph `text`, which the shared expect.json visibleIncludes rely on.
 */
export function bodyText(content) {
  const bibl = content.match(/<text:section\b[^>]*\btext:name="ZOTERO_BIBL[\s\S]*?<\/text:section>/);
  const body = bibl ? content.replace(bibl[0], "") : content;
  return [...body.matchAll(/<text:p\b[^>]*>([\s\S]*?)<\/text:p>/g)].map((m) => dec(stripTags(m[1])));
}

const ITEM_PREFIX = "ZOTERO_ITEM CSL_CITATION ";
const BIBL_STYLE = "Bibliography_20_1";

// Where LibreOffice legitimately differs from the Word expectations of the shared expect.json: the lo-proxy driver
// loads each document in a fresh LibreOffice frame, so a second refresh of an already-cited document (again) and a
// restyle re-resolve every item from the embedded itemData (the library is empty), i.e. embeddedFallback "all" —
// whereas Word's wordcraft keeps the items cached in its session, so word-proxy expects []. Not a product difference.
const LO_OVERRIDES = {
  again: { embeddedFallback: "all" },
  restyle: { embeddedFallback: "all" },
};

/**
 * Citations of a content.xml: each reference mark named "ZOTERO_ITEM CSL_CITATION <json> RND<10>" with the visible
 * text between its start and end marks. The name is an attribute value, so XML-decoded before the JSON is parsed;
 * the trailing " <10 alnum>" salt (reference-mark names must be unique) is removed first.
 */
export function citations(content) {
  const out = [];
  const starts = [...content.matchAll(/<text:reference-mark-start\b[^>]*\btext:name="([^"]*)"[^>]*\/?>/g)];
  for (const m of starts) {
    const name = dec(m[1]);
    if (!name.startsWith(ITEM_PREFIX)) continue;
    // name is `ZOTERO_ITEM CSL_CITATION {json} RND<10>`: the CSL object runs from the first { to the last } (the
    // trailing salt, the literal "RND" plus 10 chars, has no braces); more robust than stripping a fixed suffix.
    const open = name.indexOf("{");
    const close = name.lastIndexOf("}");
    let json;
    try {
      json = JSON.parse(name.slice(open, close + 1));
    } catch {
      out.push({ parseError: true, visible: "" });
      continue;
    }
    // Visible text: everything between this start mark and the matching end mark (tags stripped)
    const endRe = new RegExp(`<text:reference-mark-end\\b[^>]*\\btext:name="${m[1].replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"[^>]*/?>`);
    const after = content.slice(m.index + m[0].length);
    const end = after.match(endRe);
    const visible = end ? dec(stripTags(after.slice(0, end.index))) : "";
    out.push({ json, visible });
  }
  return out;
}

/** The ZOTERO_BIBL section (name, entries) of a content.xml, or null. Entries = paragraphs with the Bibliography style. */
export function bibliography(content) {
  const m = content.match(/<text:section\b[^>]*\btext:name="(ZOTERO_BIBL[^"]*)"[^>]*>([\s\S]*?)<\/text:section>/);
  if (!m) return null;
  const inner = m[2];
  const entries = [...inner.matchAll(/<text:p\b[^>]*\btext:style-name="([^"]*)"[^>]*>([\s\S]*?)<\/text:p>/g)]
    .filter((p) => p[1] === BIBL_STYLE)
    .map((p) => dec(stripTags(p[2])).trim())
    .filter(Boolean);
  return { name: dec(m[1]), entries };
}

/** Document preferences from meta.xml: the ZOTERO_PREF_1..n user-defined fields concatenated, then style and fieldType. */
export function prefs(meta) {
  const chunks = [];
  for (let i = 1; ; i++) {
    const m = meta.match(new RegExp(`<meta:user-defined\\b[^>]*\\bmeta:name="ZOTERO_PREF_${i}"[^>]*>([\\s\\S]*?)</meta:user-defined>`));
    if (!m) break;
    chunks.push(dec(m[1]));
  }
  if (!chunks.length) return { written: false };
  const data = chunks.join("");
  return {
    written: true,
    styleInDoc: data.match(/style id="([^"]+)"/)?.[1],
    fieldType: data.match(/name="fieldType" value="([^"]+)"/)?.[1],
  };
}

/** Facts of one refreshed .odt. `events`: the plugin/log events of its step. */
export async function inspect(odt, driver, events) {
  const zip = await JSZip.loadAsync(odt);
  const content = (await zip.file("content.xml")?.async("string")) ?? "";
  const meta = (await zip.file("meta.xml")?.async("string")) ?? "";
  const cites = citations(content);
  const bibl = bibliography(content);
  const pref = prefs(meta);
  const idsByUri = {};
  for (const c of cites) if (c.json) for (const i of c.json.citationItems ?? []) (idsByUri[i.uris[0]] ??= new Set()).add(String(i.id));
  return {
    completed: /complete, saved/.test(driver),
    citations: cites.length,
    parseErrors: cites.filter((c) => c.parseError).length,
    visible: bodyText(content),
    markText: cites.map((c) => c.visible),
    alerts: events.filter((e) => e.alert !== undefined).length,
    bibliographySection: Boolean(bibl),
    bibliographyName: bibl?.name,
    bibliography: bibl?.entries ?? [],
    bibliographyEntries: bibl?.entries.length ?? 0,
    placeholderLeft: content.includes("[Bibliography will be generated by Zotero]"),
    prefsWritten: pref.written,
    styleInDoc: pref.styleInDoc,
    fieldType: pref.fieldType,
    oneIdPerUri: Object.values(idsByUri).every((ids) => ids.size === 1),
    distinctUris: Object.keys(idsByUri).length,
    uris: Object.keys(idsByUri).sort(),
    embeddedFallback: [...new Set(events.filter((e) => e.embedded).map((e) => e.embedded.split("/").pop()))].sort(),
  };
}

/** Mismatches between a step's facts and its expectations (empty = as expected). Reuses the word-proxy includes. */
export function check(facts, exp) {
  const out = [];
  const eq = (name, got, want) => {
    if (JSON.stringify(got) !== JSON.stringify(want)) out.push(`${name}: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
  };
  if (!facts.completed) out.push("command did not complete");
  if (facts.parseErrors) out.push(`${facts.parseErrors} reference mark(s) with unparseable CSL_CITATION JSON`);
  for (const [k, want] of Object.entries(exp)) {
    switch (k) {
      case "knownBug":
      case "why":
      case "docPrefsDialog":
      case "docPrefsAnswer":
      case "noteIndex":
      case "footnoteCitations":
      case "bibliographyFields":
        break; // Word-only expectations: the ODF path checks its own structure below
      case "alerts":
        eq(k, facts.alerts, want);
        break;
      case "embeddedFallback":
        if (want === "all") eq(k, facts.embeddedFallback, facts.uris.map((u) => u.split("/").pop()).sort());
        else eq(k, facts.embeddedFallback, [...want].sort());
        break;
      case "visibleIncludes":
      case "visibleExcludes": {
        const text = facts.visible.join("\n");
        for (const s of want) {
          const has = text.includes(s);
          if (k.endsWith("Includes") && !has) out.push(`${k}: "${s}" missing`);
          if (k.endsWith("Excludes") && has) out.push(`${k}: "${s}" present`);
        }
        break;
      }
      case "bibliographyIncludes":
      case "bibliographyExcludes": {
        const text = facts.bibliography.join("\n");
        for (const s of want) {
          const has = text.includes(s);
          if (k.endsWith("Includes") && !has) out.push(`${k}: "${s}" missing`);
          if (k.endsWith("Excludes") && has) out.push(`${k}: "${s}" present`);
        }
        break;
      }
      case "styleInDoc":
        eq(k, facts.styleInDoc, want);
        break;
      case "uriPrefix":
        if (!facts.uris.length || !facts.uris.every((u) => u.startsWith(want))) out.push(`uriPrefix: expected ${want}, got ${facts.uris.join(", ")}`);
        break;
      default:
        if (k in facts) eq(k, facts[k], want);
    }
  }
  // ODF structure the Word expectations do not cover
  if (!facts.bibliographySection) out.push("no ZOTERO_BIBL bibliography section");
  if (facts.placeholderLeft) out.push("bibliography placeholder left (not generated)");
  if (facts.prefsWritten && facts.fieldType !== "ReferenceMark") out.push(`fieldType: expected "ReferenceMark", got ${JSON.stringify(facts.fieldType)}`);
  return out;
}

async function main(argv) {
  const ei = argv.indexOf("--expect");
  const expect = ei >= 0 ? JSON.parse(await readFile(argv[ei + 1], "utf8")) : null;
  const [dir, ...steps] = argv.filter((_, i) => ei < 0 || (i !== ei && i !== ei + 1));
  const events = (await readFile(join(dir, "events.jsonl"), "utf8")).split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const library = JSON.parse(await readFile(new URL("../fixtures/corpus/library.json", import.meta.url), "utf8"));
  const report = { zotero: events.find((e) => e.ready)?.zotero, steps: {}, problems: {} };
  for (const step of steps) {
    const start = events.findIndex((e) => e.step === step);
    const end = events.findIndex((e, i) => i > start && e.step);
    const seg = start < 0 ? [] : events.slice(start + 1, end < 0 ? undefined : end);
    const driver = await readFile(join(dir, `${step}.driver`), "utf8").catch(() => "");
    const odt = await readFile(join(dir, `${step}.refreshed.odt`)).catch(() => null);
    const facts = odt ? await inspect(odt, driver, seg) : { completed: false };
    report.steps[step] = facts;
    const exp = expect ? expect[step] && { ...expect._all, ...expect[step], ...(LO_OVERRIDES[step] ?? {}) } : {};
    if (expect && !exp) report.problems[step] = [`no expectations for step ${step} in expect.json`];
    else {
      const prob = odt ? check(facts, exp) : ["no refreshed document"];
      if (expect ? prob.length : !facts.completed) report.problems[step] = prob;
    }
  }
  const session = [];
  for (const e of events.filter((x) => x.setupError)) session.push(`setup error: ${e.setupError}`);
  if (events.some((e) => e.missingItem)) session.push("Zotero asked for a missing item");
  for (const e of events.filter((x) => x.loaded !== undefined)) {
    if (e.loaded !== library.items.length) session.push(`load-items: ${e.loaded} items in the ${e.library} library, expected ${library.items.length}`);
  }
  if (session.length) report.problems.session = session;
  console.log(JSON.stringify(report, null, 2));
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, summary(dir, report));
  if (Object.keys(report.problems).length) {
    for (const [step, prob] of Object.entries(report.problems)) for (const msg of prob) console.error(`lo-proxy ${step}: ${msg}`);
    process.exitCode = 1;
  }
}

function summary(dir, report) {
  const cell = (s) => String(s ?? "").replace(/\|/g, "/").replace(/\n/g, " ");
  const rows = Object.entries(report.steps).map(([step, d]) => {
    const verdict = report.problems[step] ? `**${report.problems[step].length} differenze**` : "ok";
    return `| ${step} | ${verdict} | ${d.citations ?? ""} | ${cell(d.styleInDoc)} | ${cell(d.fieldType)} | ${d.alerts ?? ""} | ${cell(d.visible?.slice(1, 4).join(" · "))} | ${d.bibliographyEntries ?? ""} | ${d.embeddedFallback?.length ?? ""} |`;
  });
  const problems = Object.entries(report.problems).flatMap(([s, p]) => p.map((m) => `- \`${s}\`: ${cell(m)}`));
  return [
    `### lo-proxy: Zotero ${report.zotero ?? "?"} + LibreOffice (${dir.split("/").pop()})`,
    "",
    "| passo | esito | citazioni | stile | fieldType | avvisi | prime citazioni | voci bibliografia | voci da itemData |",
    "|---|---|---|---|---|---|---|---|---|",
    ...rows,
    "",
    ...(problems.length ? ["Differenze dalle aspettative (`test/word-proxy/expect.json`):", "", ...problems, ""] : []),
  ].join("\n");
}

if (process.argv[1] && process.argv[1].endsWith("verify.mjs")) await main(process.argv.slice(2));
