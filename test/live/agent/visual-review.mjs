// agent-out/visual-review.md: the agent's review of the pages rendered by the word-render job (agent-render/,
// index.json). One section per content problem, plus the layout remarks to check in Word, or one line when nothing
// is wrong. Format (skill test-mcp-zotero, step 6):
//
//   # Revisione visiva
//   Nessun problema di contenuto.            ← only when there is no "## Problema" section
//   ## Problema 1: <short title>
//   - Documento: <document of index.json, e.g. apa>
//   - Pagina: <image of index.json, e.g. apa-p2.png>
//   - Posizione: <where, e.g. voce di bibliografia 3, paragrafo 5 seconda citazione>
//   - Voce del corpus: <corpus id>[, <corpus id>…]
//   - Reso: <rendered text, quoted>
//   - Atteso: <expected text>
//   - Noto: <id of a known issue of index.json>          ← optional
//   ## Da verificare in Word
//   - <layout remark> (<image>)
//
// parseVisualReview reads it, visualReviewProblems checks it against index.json (verify-claims), visualReviewMarkdown
// renders it, escaped, for the Job Summary and the PR comment (summary.mjs).
export const VISUAL_REVIEW = "visual-review.md";
const FIELDS = { Documento: "document", Pagina: "image", Posizione: "where", "Voce del corpus": "items", Reso: "rendered", Atteso: "expected", Noto: "known" };
const REQUIRED = ["document", "image", "where", "items", "rendered", "expected"];

/** { problems: [{n, title, document, image, where, items[], rendered, expected, known?, missing[]}], wordChecks: [], none, errors: [] } */
export function parseVisualReview(text) {
  const out = { problems: [], wordChecks: [], none: false, errors: [] };
  let section = null;
  for (const raw of String(text).split("\n")) {
    const line = raw.trim();
    let m;
    if ((m = line.match(/^##\s+Problema\s+(\d+)\s*:\s*(.*)$/i))) {
      section = { n: Number(m[1]), title: m[2].trim(), items: [] };
      out.problems.push(section);
    } else if (/^##\s+Da verificare in Word\s*$/i.test(line)) {
      section = "word";
    } else if (/^##\s/.test(line)) {
      out.errors.push(`unknown section "${line.slice(0, 80)}"`);
      section = null;
    } else if ((m = line.match(/^[-*]\s+(.*)$/)) && section === "word") {
      out.wordChecks.push(m[1].trim());
    } else if ((m = line.match(/^[-*]\s+([^:]+):\s*(.*)$/)) && section && typeof section === "object") {
      const key = FIELDS[m[1].trim()];
      if (!key) out.errors.push(`problem ${section.n}: unknown field "${m[1].trim()}"`);
      else if (key === "items") section.items = m[2].split(",").map((s) => s.trim()).filter(Boolean);
      else section[key] = m[2].trim();
    } else if (/^nessun problema di contenuto/i.test(line) && !section) {
      out.none = true;
    }
  }
  for (const p of out.problems) p.missing = REQUIRED.filter((k) => (k === "items" ? p.items.length === 0 : !p[k]));
  return out;
}

/**
 * Problems of the review itself (verify-claims fails on them): unreadable or empty, a problem without its fields,
 * a page or document that was not rendered, a corpus id that does not exist, a known issue that does not exist or
 * does not concern that document, item or page (dialog); a known issue marked reportsRequired not reported for each
 * of its items, a document with a recorded dialog not reported. Content problems are findings, not errors: see
 * visualReviewFindings.
 */
export function visualReviewProblems(parsed, index) {
  const out = [...parsed.errors];
  const images = new Map((index?.images ?? []).map((i) => [i.image, i]));
  const corpus = new Set((index?.corpus ?? []).map((c) => c.id));
  const known = new Map((index?.knownIssues ?? []).map((k) => [k.id, k]));
  const dialogDocuments = new Set((index?.images ?? []).filter((i) => i.dialog).map((i) => i.document));
  if (!parsed.none && parsed.problems.length === 0) out.push('no "## Problema" section and no "Nessun problema di contenuto." line');
  if (parsed.none && parsed.problems.length) out.push('"Nessun problema di contenuto." together with problem sections');
  const numbers = new Set();
  for (const p of parsed.problems) {
    const label = `problem ${p.n}`;
    if (numbers.has(p.n)) out.push(`${label}: number repeated`);
    numbers.add(p.n);
    if (p.missing.length) out.push(`${label}: missing ${p.missing.join(", ")}`);
    const img = p.image ? images.get(p.image) : undefined;
    if (p.image && !img) out.push(`${label}: page ${p.image} was not rendered`);
    if (img && p.document && img.document !== p.document) out.push(`${label}: page ${p.image} belongs to ${img.document}, not ${p.document}`);
    for (const id of p.items) if (!corpus.has(id)) out.push(`${label}: ${id} is not a corpus item`);
    if (p.known) {
      const k = known.get(p.known);
      if (!k) out.push(`${label}: known issue ${p.known} does not exist`);
      else {
        // a known issue only for what it describes: never a way to downgrade another bug to a warning
        if (p.document && !k.steps.includes(p.document)) out.push(`${label}: known issue ${p.known} does not concern ${p.document}`);
        if (Array.isArray(k.items)) for (const id of p.items) if (!k.items.includes(id)) out.push(`${label}: known issue ${p.known} does not concern ${id}`);
        if (k.requiresDialog && p.document && !dialogDocuments.has(p.document)) out.push(`${label}: known issue ${p.known} needs a recorded dialog, ${p.document} has none`);
      }
    }
  }
  // Evidence that the pages were really reviewed: every known issue to report, item by item, and every document
  // whose first Refresh opened a dialog must appear among the problems
  for (const k of index?.knownIssues ?? []) {
    if (!k.reportsRequired) continue;
    for (const id of k.items ?? []) {
      if (!parsed.problems.some((p) => p.known === k.id && p.items.includes(id))) out.push(`known issue ${k.id} not reported for ${id} (it is visible on the pages)`);
    }
  }
  for (const doc of dialogDocuments) {
    if (!parsed.problems.some((p) => p.document === doc)) out.push(`${doc}: Zotero opened a dialog on the first Refresh (index.json) but no problem reports it`);
  }
  return out;
}

/** Content problems as verify-claims findings: known issues are warnings, any other is a problem (a bug). */
export function visualReviewFindings(parsed) {
  const describe = (p) => `visual ${p.n} (${p.image}, ${p.where}): ${p.title}`;
  return {
    problems: parsed.problems.filter((p) => !p.known).map(describe),
    warnings: parsed.problems.filter((p) => p.known).map((p) => `${describe(p)} [known: ${p.known}]`),
  };
}

/** "Problemi visivi" section for the Job Summary / PR comment; `inline(value, max)` escapes every agent-written value. */
export function visualReviewMarkdown(parsed, inline) {
  const t = inline;
  const lines = ["#### Problemi visivi", ""];
  if (parsed.problems.length === 0) lines.push(parsed.none ? "Nessun problema di contenuto nelle pagine renderizzate." : "Revisione visiva assente o non leggibile.", "");
  for (const p of parsed.problems) {
    const head = `${t(p.n, 5)}. ${t(p.title, 200)} — ${t(p.document, 40)}, ${t(p.image, 60)}, ${t(p.where, 120)}${p.known ? ` (noto: ${t(p.known, 20)})` : ""}`;
    lines.push(
      `<details><summary>${head}</summary>`,
      "",
      `- Voce del corpus: ${p.items.map((i) => t(i, 40)).join(", ")}`,
      `- Reso: ${t(p.rendered, 800)}`,
      `- Atteso: ${t(p.expected, 800)}`,
      "",
      "</details>",
      ""
    );
  }
  if (parsed.wordChecks.length) lines.push("**Da verificare in Word** (impaginazione: non fa fallire la run)", "", ...parsed.wordChecks.map((w) => `- ${t(w, 300)}`), "");
  return lines.join("\n");
}
