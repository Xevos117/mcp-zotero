#!/usr/bin/env node
// Markdown report of an agent smoke run, for the Job Summary and the sticky PR comment of claude-agent-smoke.yml
// (live tests + agent smoke):
// verdict, problems and warnings (verdict.json, from verify-claims), scenario table, exploratory X1..X5 and friction
// (claims.json, agent-report.json), turns, duration and cost (the result message of execution.json).
// Input: the SCRUBBED copy of agent-out (test/live/scrub-report.mjs output). Fails closed (exit 1, nothing
// written) if the text still contains a secret or identifier of the test account from the environment (same
// variables as scrub-report.mjs, group name included) or any users/<id> or groups/<id> other than the redaction
// placeholders.
// Usage: node test/live/agent/summary.mjs <scrubbed agent-out dir> --out <file.md>
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const MARKER = "<!-- mcp-zotero-agent-smoke -->";
const MAX_CELL = 300;
const MAX_TEXT = 60_000;
const SECRET_ENV = [
  "ZOTERO_TEST_API_KEY",
  "UNPAYWALL_EMAIL",
  "ZOTERO_TEST_USERNAME",
  "ZOTERO_TEST_USER_ID",
  "ZOTERO_TEST_GROUP_ID",
  "ZOTERO_TEST_GROUP_NAME",
  "ANTHROPIC_API_KEY",
];
/** Placeholders of test/live/agent/redact.mjs: not identifiers. */
const PLACEHOLDER_PATHS = new Set(["users/100000000000001", "groups/200000000000002"]);

/** Agent-written text as inert markdown: one line, no HTML, no @mentions, no table breaks, bounded. */
export function inline(value, max = MAX_CELL) {
  const text = String(value ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\|/g, "\\|")
    .replace(/@/g, "@​")
    .replace(/`/g, "'");
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** num_turns, duration_ms and total_cost_usd of the SDK result message, if the transcript has one. */
export function runStats(messages) {
  const list = Array.isArray(messages) ? messages : [];
  const result = [...list].reverse().find((m) => m?.type === "result");
  if (!result) return null;
  return { turns: result.num_turns, durationMs: result.duration_ms, costUsd: result.total_cost_usd, subtype: result.subtype };
}

function table(head, rows) {
  if (rows.length === 0) return [];
  return [`| ${head.join(" | ")} |`, `|${head.map(() => "---").join("|")}|`, ...rows.map((r) => `| ${r.join(" | ")} |`)];
}

/** The report as markdown (starts with MARKER, used to find the sticky comment). */
export function buildSummary({ verdict, report, claims, stats, headSha }) {
  const lines = [MARKER];
  const title = !verdict ? "no verdict (verify-claims did not run or failed early)" : verdict.verified ? "claims verified" : "claims NOT verified";
  lines.push(`### Agent smoke: ${title}`, "");
  const facts = [];
  if (headSha) facts.push(`head ${inline(String(headSha).slice(0, 7))}`);
  if (verdict) facts.push(`${verdict.checks ?? 0} checks passed`, `${verdict.problems?.length ?? 0} problems`, `${verdict.warnings?.length ?? 0} warnings`);
  if (stats) {
    if (Number.isFinite(stats.turns)) facts.push(`${stats.turns} turns`);
    if (Number.isFinite(stats.durationMs)) facts.push(`${Math.round(stats.durationMs / 60_000)} min`);
    if (Number.isFinite(stats.costUsd)) facts.push(`$${stats.costUsd.toFixed(2)}`);
    if (stats.subtype && stats.subtype !== "success") facts.push(`agent ended with ${inline(stats.subtype)}`);
  }
  if (facts.length) lines.push(facts.join(" · "), "");
  const list = (label, items) => (items?.length ? [`**${label}**`, ...items.map((p) => `- ${inline(p, 500)}`), ""] : []);
  lines.push(...list("Problems", verdict?.problems), ...list("Warnings", verdict?.warnings));

  const scenarios = (Array.isArray(claims?.scenarios) ? claims.scenarios : Array.isArray(report?.scenarios) ? report.scenarios : []).map((s) => [
    inline(s?.id, 20),
    inline(s?.status, 20),
    inline(s?.notes),
  ]);
  if (scenarios.length) lines.push("#### Scenarios", "", ...table(["ID", "Status", "Notes"], scenarios), "");

  const exploratory = (Array.isArray(claims?.exploratory) ? claims.exploratory : []).slice(0, 5).map((x) => [
    inline(x?.id, 10),
    inline(x?.verdict, 20),
    inline(x?.rationale),
    inline(x?.observed),
  ]);
  if (exploratory.length) lines.push("#### Exploratory", "", ...table(["ID", "Verdict", "Rationale", "Observed"], exploratory), "");

  const friction = Array.isArray(report?.friction) && report.friction.length ? report.friction : Array.isArray(claims?.friction) ? claims.friction : [];
  if (friction.length) lines.push("#### Friction", "", ...friction.map((f) => `- **${inline(f?.tool, 60)}**: ${inline(f?.note, 500)}`), "");

  if (report?.summary) lines.push("<details><summary>Agent report</summary>", "", inline(report.summary, 3000), "", "</details>", "");
  let text = lines.join("\n");
  if (text.length > MAX_TEXT) text = `${text.slice(0, MAX_TEXT)}\n\n(truncated)\n`;
  return text;
}

/** Why the text must not be published (empty = clean): secrets of the environment, users|groups/<id> paths. */
export function leakProblems(text, env = process.env) {
  const out = [];
  if ((env.ZOTERO_TEST_GROUP_ID ?? "").trim() && !(env.ZOTERO_TEST_GROUP_NAME ?? "").trim()) {
    out.push("ZOTERO_TEST_GROUP_NAME missing (run test/live/mask-group-name.mjs first in this job)");
  }
  for (const name of SECRET_ENV) {
    const value = (env[name] ?? "").trim();
    if (value.length >= 3 && text.includes(value)) out.push(`${name} present in the text`);
  }
  const paths = [...text.matchAll(/\b(?:users|groups)\/\d+/g)].map((m) => m[0]).filter((p) => !PLACEHOLDER_PATHS.has(p));
  if (paths.length) out.push(`${paths.length} users/<id> or groups/<id> path(s) in the text`);
  return out;
}

function readJson(dir, name) {
  const p = join(dir, name);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

function readTranscript(dir) {
  const p = join(dir, "execution.json");
  if (!existsSync(p)) return null;
  const text = readFileSync(p, "utf8").trim();
  try {
    return text.startsWith("[") ? JSON.parse(text) : text.split("\n").map((l) => JSON.parse(l));
  } catch {
    return null;
  }
}

function main() {
  const args = process.argv.slice(2);
  const outIndex = args.indexOf("--out");
  const out = outIndex >= 0 ? args[outIndex + 1] : undefined;
  const dir = args.find((a, i) => !a.startsWith("--") && i !== outIndex + 1);
  if (!dir || !out) {
    console.error("usage: summary.mjs <scrubbed agent-out dir> --out <file.md>");
    return 2;
  }
  const text = buildSummary({
    verdict: readJson(dir, "verdict.json"),
    report: readJson(dir, "agent-report.json"),
    claims: readJson(dir, "claims.json"),
    stats: runStats(readTranscript(dir)),
    headSha: process.env.HEAD_SHA,
  });
  const leaks = leakProblems(text);
  if (leaks.length) {
    console.error(`summary: not written, ${leaks.join("; ")}`);
    return 1;
  }
  writeFileSync(out, text);
  console.log(`summary: ${text.length} characters → ${out}`);
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exit(main());
