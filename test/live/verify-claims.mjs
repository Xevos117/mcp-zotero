#!/usr/bin/env node
// Deterministic verdict for the agent smoke test (test-mcp-zotero skill). The agent's own report is
// informative only: this script checks what the agent claims in agent-out/claims.json against the
// Zotero Web API and validates every produced .docx with test/helpers/docx-validate.ts.
// Usage: ZOTERO_TEST_API_KEY=... node test/live/verify-claims.mjs [agent-out]
// Exit 0 = verified, 1 = claims not verified, 2 = setup error. Writes <dir>/verdict.json and, in CI,
// a summary to $GITHUB_STEP_SUMMARY. No secret or library content is printed.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { citations, validateDocx } from "../helpers/docx-validate.ts";

const DIR = resolve(process.argv[2] ?? "agent-out");
const KEY = process.env.ZOTERO_TEST_API_KEY ?? "";
const REQUEST_TIMEOUT_MS = 30_000;
const REQUIRED = ["P0", "F1", "F2", "F3", "F4", "F5", "F6", "F8"];
/** Fixed scenarios that depend on external services (doi.org, Unpaywall, publishers) may be skipped with a reason. */
const MAY_SKIP = new Set(["F1"]);
const STYLES = new Set(["apa", "ieee", "vancouver", "harvard", "chicago"]);

const problems = [];
const checks = [];
const fail = (msg) => problems.push(msg);
const ok = (msg) => checks.push(msg);
const scrub = (t) => (KEY ? String(t).split(KEY).join("***") : String(t));

function readJson(name) {
  const p = join(DIR, name);
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, "utf8"));
}

async function api(path) {
  for (let attempt = 1; ; attempt++) {
    let res;
    try {
      res = await fetch(`https://api.zotero.org/${path}`, {
        headers: { "Zotero-API-Key": KEY, "Zotero-API-Version": "3" },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (e) {
      if (attempt >= 4) throw new Error(scrub(`GET ${path}: ${e.message}`));
      await new Promise((r) => setTimeout(r, 1000 * attempt));
      continue;
    }
    if ([429, 502, 503, 504].includes(res.status) && attempt < 4) {
      const wait = Number(res.headers.get("retry-after") ?? attempt * 2);
      await new Promise((r) => setTimeout(r, Math.min(wait, 30) * 1000));
      continue;
    }
    const text = await res.text();
    let data;
    try {
      data = text ? JSON.parse(text) : undefined;
    } catch {
      data = undefined;
    }
    return { status: res.status, data, text };
  }
}

const LIB = /^(users|groups)\/\d+$/;

async function main() {
  if (!KEY) {
    console.error("verify-claims: ZOTERO_TEST_API_KEY not set");
    return 2;
  }
  const context = readJson("context.json");
  const claims = readJson("claims.json");
  if (!context) {
    console.error(`verify-claims: ${join(DIR, "context.json")} missing (run test/live/agent/prepare.mjs first)`);
    return 2;
  }
  if (!claims) {
    fail("claims.json missing: the agent did not complete the skill");
    return finish(context);
  }
  if (claims.schema_version !== 1) fail(`claims.schema_version ${claims.schema_version} != 1`);
  if (claims.run_id !== context.run_id) fail(`claims.run_id ${claims.run_id} != context run ${context.run_id}`);

  // Scenarios: the fixed path must be reported, and nothing may be reported as failed
  const scenarios = new Map((claims.scenarios ?? []).map((s) => [s.id, s]));
  const required = [...REQUIRED, ...(context.group_id ? ["F7"] : [])];
  for (const id of required) {
    const s = scenarios.get(id);
    if (!s) fail(`scenario ${id} not reported`);
    else if (s.status === "skipped" && MAY_SKIP.has(id) && s.notes) ok(`scenario ${id} skipped: ${s.notes}`);
    else if (s.status !== "passed") fail(`scenario ${id} ${s.status ?? "without status"}${s.notes ? `: ${s.notes}` : ""}`);
  }
  for (const s of scenarios.values()) if (s.status === "failed" && !required.includes(s.id)) fail(`scenario ${s.id} failed${s.notes ? `: ${s.notes}` : ""}`);

  // Created objects: they exist (unless claimed deleted), carry the run markers and match the claimed state
  const created = claims.created ?? [];
  const deleted = new Set((claims.deleted ?? []).map((d) => `${d.library_path}/${d.key}`));
  // keys the run created, still present or deleted by the agent (local runs move them to "deleted")
  const createdKeys = new Set([...created, ...(claims.deleted ?? [])].map((c) => `${c.library_path}/${c.key}`));
  const collectionKeys = new Set(created.filter((c) => c.kind === "collection").map((c) => c.key));
  const titles = new Map();
  const verifiedItems = new Set();
  const pending = [];
  for (const c of created) {
    const id = `${c.library_path}/${c.key}`;
    if (!LIB.test(c.library_path ?? "") || !/^[A-Z0-9]{8}$/.test(c.key ?? "")) {
      fail(`created entry with invalid library_path/key: ${JSON.stringify({ kind: c.kind, key: c.key, library_path: c.library_path })}`);
      continue;
    }
    if (deleted.has(id)) continue;
    if (context.cleanup === "agent") continue; // local run: the agent deleted everything, checked below
    if (c.kind === "collection") {
      const r = await api(`${c.library_path}/collections/${c.key}`);
      if (r.status !== 200) fail(`collection ${c.key}: HTTP ${r.status}`);
      else if (!String(r.data.data.name).startsWith(context.prefix)) fail(`collection ${c.key}: name without the run prefix`);
      else if (c.expect?.parent_collection && r.data.data.parentCollection !== c.expect.parent_collection) fail(`collection ${c.key}: parent differs from the claim`);
      else ok(`collection ${c.key}`);
      continue;
    }
    const r = await api(`${c.library_path}/items/${c.key}`);
    if (r.status !== 200) {
      fail(`${c.kind} ${c.key}: HTTP ${r.status}`);
      continue;
    }
    const d = r.data.data;
    titles.set(id, d.title);
    pending.push({ c, d, id });
  }
  // markers: title with run id, run tag, run collection or a verified parent
  const marked = ({ d }) =>
    String(d.title ?? "").includes(context.run_id) ||
    (d.tags ?? []).some((t) => t.tag === context.run_tag) ||
    (d.collections ?? []).some((k) => collectionKeys.has(k));
  for (const p of pending) if (marked(p)) verifiedItems.add(p.d.key);
  for (const p of pending) if (!verifiedItems.has(p.d.key) && p.d.parentItem && verifiedItems.has(p.d.parentItem)) verifiedItems.add(p.d.key);
  for (const { c, d } of pending) {
    if (!verifiedItems.has(d.key)) {
      fail(`${c.kind} ${c.key}: no run marker (title, tag ${context.run_tag}, run collection or verified parent)`);
      continue;
    }
    const e = c.expect ?? {};
    const bad = [];
    if (e.title && d.title !== e.title) bad.push("title");
    if (e.doi && String(d.DOI ?? "").toLowerCase() !== String(e.doi).toLowerCase()) bad.push("DOI");
    if (e.collection && !(d.collections ?? []).includes(e.collection)) bad.push("collection");
    if (e.parent_item && d.parentItem !== e.parent_item) bad.push("parent_item");
    if (e.link_mode && d.linkMode !== e.link_mode) bad.push("link_mode");
    if (e.has_pdf) {
      const ch = await api(`${c.library_path}/items/${c.key}/children?limit=100`);
      const pdf = (ch.data ?? []).some((x) => x.data.contentType === "application/pdf" && x.data.linkMode !== "linked_url");
      if (!pdf) bad.push("has_pdf");
    }
    if (bad.length) fail(`${c.kind} ${c.key}: state differs from the claim (${bad.join(", ")})`);
    else ok(`${c.kind} ${c.key}`);
  }

  // Deleted objects are really gone
  for (const dItem of claims.deleted ?? []) {
    if (!LIB.test(dItem.library_path ?? "")) {
      fail(`deleted entry with invalid library_path: ${dItem.key}`);
      continue;
    }
    const kind = dItem.kind === "collection" ? "collections" : "items";
    const r = await api(`${dItem.library_path}/${kind}/${dItem.key}`);
    if (r.status !== 404) fail(`${dItem.kind ?? "item"} ${dItem.key} claimed deleted but HTTP ${r.status}`);
    else ok(`deleted ${dItem.key}`);
  }

  // Produced documents: valid structure/CSL/rendering, URIs pointing at created items
  const reports = new Map();
  for (const doc of claims.docx ?? []) {
    const path = resolve(doc.path ?? "");
    if (!path.startsWith(resolve("agent-out") + sep) || !existsSync(path)) {
      fail(`docx ${doc.path}: missing or outside agent-out/`);
      continue;
    }
    if (!STYLES.has(doc.style)) {
      fail(`docx ${doc.path}: unknown style ${doc.style}`);
      continue;
    }
    const report = await validateDocx(readFileSync(path), { style: doc.style, libraryPath: doc.library_path });
    for (const e of report.errors) fail(`docx ${doc.path}: ${e}`);
    // the numbering is the agent's choice; for author-date styles the visible text must match citeproc
    if (!["ieee", "vancouver"].includes(doc.style)) for (const m of report.mismatches) fail(`docx ${doc.path}: ${m}`);
    if (report.citations.length === 0) fail(`docx ${doc.path}: no citations`);
    for (const cite of report.citations) {
      for (const ci of cite.json.citationItems ?? []) {
        const m = /^http:\/\/zotero\.org\/((?:users|groups)\/\d+)\/items\/([A-Z0-9]{8})$/.exec(ci.uris?.[0] ?? "");
        if (!m) continue; // already reported by the validator
        const id = `${m[1]}/${m[2]}`;
        if (!createdKeys.has(id)) fail(`docx ${doc.path}: cites ${m[2]}, which is not among the created items`);
        else if (context.cleanup !== "agent" && titles.has(id) && titles.get(id) !== ci.itemData?.title) fail(`docx ${doc.path}: itemData title of ${m[2]} differs from Zotero`);
      }
    }
    reports.set(doc.path, { doc, report });
    if (!problems.some((p) => p.startsWith(`docx ${doc.path}`))) ok(`docx ${doc.path} (${doc.producer}, ${doc.style})`);
  }
  // inject_citations and inject.js on the same input must produce the same field JSON
  const groups = new Map();
  for (const { doc, report } of reports.values()) {
    if (!doc.compare_group) continue;
    const list = groups.get(doc.compare_group) ?? [];
    list.push({ doc, cites: citations(report.documentXml).map((c) => ({ text: c.properties?.formattedCitation, items: (c.citationItems ?? []).map((ci) => ({ uris: ci.uris, itemData: ci.itemData, locator: ci.locator })) })) });
    groups.set(doc.compare_group, list);
  }
  for (const [name, list] of groups) {
    if (list.length < 2) fail(`compare_group ${name}: only one document`);
    else if (list.some((x) => JSON.stringify(x.cites) !== JSON.stringify(list[0].cites))) fail(`compare_group ${name}: inject_citations and inject.js differ`);
    else ok(`compare_group ${name}: identical field JSON`);
  }

  // Local runs: the agent cleaned up after itself
  if (context.cleanup === "agent") {
    const libs = new Set(created.map((c) => c.library_path));
    for (const lib of libs) {
      const r = await api(`${lib}/items?tag=${encodeURIComponent(context.run_tag)}&limit=1&format=keys`);
      if (r.status === 200 && r.text.trim()) fail(`${lib}: items with ${context.run_tag} left after the agent cleanup`);
    }
  }
  return finish(context);
}

function finish(context) {
  const verdict = { run_id: context.run_id, verified: problems.length === 0, problems, checks: checks.length };
  writeFileSync(join(DIR, "verdict.json"), scrub(JSON.stringify(verdict, null, 2)) + "\n");
  const lines = [
    `### Agent smoke: ${verdict.verified ? "claims verified" : "claims NOT verified"}`,
    "",
    `${checks.length} checks passed, ${problems.length} problems.`,
    ...problems.map((p) => `- ${scrub(p)}`),
  ];
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join("\n") + "\n");
  console.log(lines.join("\n"));
  return verdict.verified ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(`verify-claims: ${scrub(e instanceof Error ? e.message : String(e))}`);
    process.exit(2);
  }
);
