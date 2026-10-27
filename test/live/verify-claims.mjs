#!/usr/bin/env node
// Deterministic verdict for the agent smoke test (test-mcp-zotero skill). The agent's own report is
// informative only: this script checks what the agent claims in agent-out/claims.json against the
// Zotero Web API and the evidence of the run, and validates every produced .docx with test/helpers/docx-validate.ts.
// Usage: ZOTERO_TEST_API_KEY=... node test/live/verify-claims.mjs [agent-out] --audit <audit.jsonl> [--transcript <file>]
//        [--render <dir with index.json> [--visual-review required|optional]]
// Evidence: the audit log written by the PostToolUse hooks of .claude/agent-smoke (every Zotero call and Bash
// command with its result, outside the agent's reach) and the denials.jsonl next to it (PreToolUse denials).
// The optional transcript (claude-code-action execution file, or a stream-json / session .jsonl) is cross-checked:
// every Zotero call in it must be in the audit or among the denials. From the audit the script:
// - attributes every claimed deletion to a Zotero tool call of the run (created by it, or reported deleted);
// - scans every Zotero tool result for robustness failures (crash, error without isError, leaked
//   "[object Object]"/undefined/NaN, stack traces) and every write call for keys the run did not create;
// - checks the guardrail probes (F0), the fixed edge cases (F9, F10) and that every claimed exploratory call
//   (X1..X5) was really made.
// With --render (the pages of the word-render job), agent-out/visual-review.md must reference only rendered pages,
// their documents, corpus items and known issues of index.json; a content problem is a finding (a problem, or a
// warning when the agent marks it as a known issue that concerns that document); layout remarks never fail.
// `--visual-review optional` (a pull request whose base branch's skill has no visual review yet) accepts a missing file.
// Claims schema 3 (written only by the skill that introduced it; on a pull request the agent follows the base branch's
// skill, so a schema 2 file is judged exactly as before) adds: the targeted scenarios the changed files select
// (.claude/skills/test-mcp-zotero/scenarios.json, from the trusted context), every created key declared or deleted,
// created objects and metadata files referenced by call_no, document preferences in every document with citations and
// in the parity fingerprint, the "preferences kept" case (F11), F10 rows met by any matching call, a skipped F1 only
// with an audited external failure, and a warning for every deletion outside F8.
// Exit 0 = verified, 1 = claims not verified, 2 = setup error. Writes <dir>/verdict.json; the Job Summary and the
// PR comment are written from its scrubbed copy by test/live/agent/summary.mjs. No secret or library content is
// printed.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";
import { validateDocx } from "../helpers/docx-validate.ts";
import { validateOdt } from "../helpers/citation-validate.ts";
import { VISUAL_REVIEW, parseVisualReview, visualReviewFindings, visualReviewProblems } from "./agent/visual-review.mjs";
import { loadScenarios, targetedScenarios } from "./agent/scenarios.mjs";
import { externalReason } from "./helpers/external.mjs";

const args = process.argv.slice(2);
const option = (name) => (args.indexOf(name) >= 0 ? args[args.indexOf(name) + 1] : undefined);
const TRANSCRIPT = option("--transcript");
const AUDIT = option("--audit");
const RENDER = option("--render");
const VISUAL = option("--visual-review") ?? "required";
const DIR = resolve(args.find((a, i) => !a.startsWith("--") && !["--transcript", "--audit", "--render", "--visual-review"].includes(args[i - 1])) ?? "agent-out");
const ZOTERO_KEY = /^[23456789ABCDEFGHIJKLMNPQRSTUVWXYZ]{8}$/;
const KEY = process.env.ZOTERO_TEST_API_KEY ?? "";
const REQUEST_TIMEOUT_MS = 30_000;
/** Claims schemas accepted: 2 (skills before schema 3, judged as before) and 3. */
const SCHEMA_VERSIONS = [2, 3];
const REQUIRED = ["P0", "F0", "F1", "F2", "F3", "F4", "F5", "F6", "F8", "F9", "F10"];
/** Schema 3 only: the "preferences kept" case. */
const REQUIRED_V3 = ["F11"];
/** Fixed scenarios that depend on external services (doi.org, Unpaywall, publishers) may be skipped with a reason. */
const MAY_SKIP = new Set(["F1"]);
const STYLES = ["apa", "ieee", "vancouver", "harvard", "chicago"];
const NUMBERED = new Set(["ieee", "vancouver"]);
/** Valid-shape keys that exist in no library: the only foreign keys the agent may pass to a write tool. */
export const FAKE_KEYS = new Set(["ZZZZZZZZ", "YYYYYYYY"]);
/** F0: a delete of this key (exists nowhere, not in FAKE_KEYS) must be denied by the delete hook. */
export const PROBE_KEY = "XXXXXXXX";
/** F0: this exact Bash command (chained) must be denied by the Bash hook. */
export const PROBE_COMMAND = /^node test\/live\/agent\/make-docx\.mjs agent-out\/[A-Za-z0-9._-]+-probe\.docx '\[\["probe"\]\]' && ls$/;
const MAX_EXPLORATORY = 5;
const LIB = /^(users|groups)\/\d+$/;
const ZOTERO_PREFIX = "mcp__zotero__";
const INJECT_CMD = /^node test\/live\/agent\/inject\.mjs\s/;
const INVALID_ZCITE = "Invalid Zotero item key(s) in <zcite>";
/** Ids of the CSL styles in the Zotero document preferences (src/citation-injector/document-prefs.ts). */
const STYLE_IDS = {
  apa: "http://www.zotero.org/styles/apa",
  ieee: "http://www.zotero.org/styles/ieee",
  vancouver: "http://www.zotero.org/styles/nlm-citation-sequence",
  harvard: "http://www.zotero.org/styles/harvard-cite-them-right",
  chicago: "http://www.zotero.org/styles/chicago-author-date",
};
/** F8 (and T-delete): the only objects a CI run deletes are named "<prefix> … to delete". */
const TO_DELETE = /\bto delete$/;

const problems = [];
const warnings = [];
const checks = [];
/** Audited calls referenced by the exploratory scenarios (verdict.json, shown in the report). */
const exploratoryCalls = [];
const fail = (msg) => problems.push(msg);
const problemsFail = fail;
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
    if ([429, 500, 502, 503, 504].includes(res.status) && attempt < 4) {
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

/**
 * Whether a claims.deleted entry is satisfied by the API response `r` for that key.
 * - collections: only HTTP 404 counts (the Zotero Web API has no trash for collections).
 * - items with `permanent: true` in the claim: only 404 counts — an item left in the trash (200 +
 *   deleted:1) is a FAILURE, so a regression where permanent only trashes is caught (F8 permanent probe).
 * - items otherwise: 404 (permanently gone) or 200 with deleted:1 (moved to the trash) are both valid.
 */
export function deletedClaimOutcome(dItem, r) {
  const kind = dItem.kind === "collection" ? "collections" : "items";
  if (r.status === 404) return { ok: true, message: `deleted ${dItem.key}` };
  const trashed = kind === "items" && r.status === 200 && r.data?.data?.deleted === 1;
  if (trashed && !dItem.permanent) return { ok: true, message: `trashed ${dItem.key}` };
  const why = trashed
    ? " but only in the trash (permanent deletion was claimed)"
    : r.status === 200
      ? " and not in the trash"
      : "";
  return { ok: false, message: `${dItem.kind ?? "item"} ${dItem.key} claimed deleted but HTTP ${r.status}${why}` };
}

// ---------------------------------------------------------------------------------------------------
// Transcript
// ---------------------------------------------------------------------------------------------------

/** Transcript file: a JSON array of SDK messages, or one message per line (stream-json, session .jsonl). */
export function parseTranscript(text) {
  const trimmed = text.trim();
  if (trimmed.startsWith("[")) return JSON.parse(trimmed);
  return trimmed
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

const resultText = (content) =>
  typeof content === "string" ? content : (Array.isArray(content) ? content : []).filter((c) => c?.type === "text").map((c) => c.text).join("");

/**
 * Every tool call of the transcript in order: `{ id, name, tool, input, result }`, where `tool` is the Zotero
 * tool name (without the mcp__zotero__ prefix) or null, and `result` is `{ isError, text }` or null.
 */
export function toolCalls(messages) {
  if (Array.isArray(messages) && messages.length > 0 && messages.every((m) => m?.isCall === true)) return messages;
  const calls = [];
  const byId = new Map();
  for (const m of Array.isArray(messages) ? messages : []) {
    for (const block of Array.isArray(m?.message?.content) ? m.message.content : []) {
      if (block?.type === "tool_use") {
        const name = String(block.name);
        const call = { isCall: true, id: block.id, name, tool: name.startsWith(ZOTERO_PREFIX) ? name.slice(ZOTERO_PREFIX.length) : null, input: block.input ?? {}, result: null };
        byId.set(block.id, call);
        calls.push(call);
      } else if (block?.type === "tool_result" && byId.has(block.tool_use_id)) {
        byId.get(block.tool_use_id).result = { isError: block.is_error === true, text: resultText(block.content) };
      }
    }
  }
  return calls;
}

/** Calls from the hook audit log (agent-audit/audit.jsonl), in the same form as toolCalls, plus the hook's callNo. */
export function auditCalls(entries) {
  return (Array.isArray(entries) ? entries : [])
    .filter((e) => e && typeof e.tool_name === "string")
    .map((e) => ({
      isCall: true,
      id: e.tool_use_id,
      callNo: e.call_no,
      name: e.tool_name,
      tool: e.tool_name.startsWith(ZOTERO_PREFIX) ? e.tool_name.slice(ZOTERO_PREFIX.length) : null,
      input: e.tool_input ?? {},
      result: { isError: e.is_error === true, text: String(e.text ?? "") },
    }));
}

/**
 * Cross-check of the audit against the transcript: every Zotero call of the transcript must be in the audit or
 * among the denials (a missing entry means the hooks did not run, or the call never returned).
 */
export function auditGaps(messages, entries, denials) {
  const known = new Set([...entries, ...denials].map((e) => e?.tool_use_id).filter(Boolean));
  return toolCalls(messages)
    .map((c, i) => ({ c, i }))
    // A call the client could not parse ({"__unparsedToolInput": …}, e.g. the model wrote `"permanent": yes`
    // instead of `true`) never reaches the tool, so neither the PostToolUse audit hook nor a deny-hook can
    // record it. It is the SDK rejecting malformed JSON, not a Zotero call that ran without an audit entry.
    .filter(({ c }) => c.tool && !known.has(c.id) && !isUnparsedInput(c))
    .map(({ c, i }) => `call #${i + 1} ${c.tool} of the transcript has no audit entry (hooks not active, or no result)`);
}

/** A tool call whose arguments the client could not parse as JSON (SDK marks it with __unparsedToolInput). */
export function isUnparsedInput(call) {
  return !!call?.input && typeof call.input === "object" && "__unparsedToolInput" in call.input;
}

/**
 * The audit hook numbers every call it records (call_no 1..n, the reference claims.json uses): once any entry has a
 * number, all must, without repeats or gaps (a gap is a call whose entry was lost). An audit without numbers comes
 * from hooks that predate them (a pull request's agent runs the base branch's hooks).
 */
export function auditNumberingProblems(entries) {
  const list = (Array.isArray(entries) ? entries : []).filter((e) => e && typeof e.tool_name === "string");
  if (!list.some((e) => e.call_no !== undefined)) return [];
  const out = [];
  const numbers = list.map((e) => e.call_no);
  const bad = numbers.filter((n) => !Number.isInteger(n) || n < 1).length;
  if (bad) out.push(`audit: ${bad} entr${bad === 1 ? "y" : "ies"} without a valid call_no`);
  const valid = numbers.filter((n) => Number.isInteger(n) && n >= 1);
  const repeated = valid.length - new Set(valid).size;
  if (repeated) out.push(`audit: ${repeated} repeated call_no`);
  const max = Math.max(0, ...valid);
  const missing = max - new Set(valid).size;
  if (missing > 0) out.push(`audit: ${missing} call_no missing between 1 and ${max} (lost entries)`);
  return out;
}

/** The two mandatory F0 probes (a chained Bash command and a delete of a nonexistent key) the hooks must deny. */
export const isF0BashProbe = (d) => d?.tool_name === "Bash" && PROBE_COMMAND.test(String(d?.tool_input?.command ?? ""));
export const isF0DeleteProbe = (d) => d?.tool_name === `${ZOTERO_PREFIX}delete_items` && canonical(d?.tool_input?.item_keys) === canonical([PROBE_KEY]);
export const isF0Probe = (d) => isF0BashProbe(d) || isF0DeleteProbe(d);

/** F0 and denials: the two probes must be denied by the hooks; any other denial is a warning. */
export function guardrailFindings(denials) {
  const res = { problems: [], warnings: [] };
  if (!denials.some(isF0BashProbe)) res.problems.push("F0: the chained Bash probe was not denied by the Bash hook");
  if (!denials.some(isF0DeleteProbe)) res.problems.push(`F0: the delete of ${PROBE_KEY} was not denied by the delete hook`);
  for (const d of denials.filter((x) => !isF0Probe(x))) res.warnings.push(`denied by the hooks: ${d.tool_name} (${String(d.reason ?? "").split(".")[0]})`);
  return res;
}

/** JSON body of a successful Zotero tool result, or null. */
function successJson(call) {
  if (!call.tool || !call.result || call.result.isError) return null;
  try {
    const json = JSON.parse(call.result.text);
    return json && typeof json === "object" && !json.error ? json : null;
  } catch {
    return null;
  }
}

/** Keys a single call created and deleted (only from structured fields of successful results). */
function callEffects(call) {
  const created = [];
  const deleted = [];
  const json = successJson(call);
  if (!json) return { created, deleted };
  const add = (list, key) => typeof key === "string" && ZOTERO_KEY.test(key) && list.push(key);
  switch (call.tool) {
    case "delete_items":
      for (const k of json.deleted_keys ?? []) add(deleted, k);
      break;
    case "delete_collection":
      if (json.deleted === true) add(deleted, json.collection_key);
      break;
    case "create_collection":
      add(created, json.collection_key);
      break;
    case "add_items":
    case "add_items_by_doi":
      for (const x of json.success ?? []) add(created, x?.item_key);
      for (const x of json.pdf_results ?? []) add(created, x?.attachment_key);
      break;
    case "add_linked_url_attachment":
    case "import_pdf_to_zotero":
      add(created, json.item_key);
      break;
    case "find_and_attach_pdfs":
      for (const x of json.results ?? []) add(created, x?.attachment_key);
      break;
    case "create_note":
      add(created, json.note_key ?? json.item_key ?? json.key);
      break;
    case "create_cited_document":
      break; // writes a document file, creates no Zotero items: no keys to attribute
  }
  return { created, deleted };
}

/**
 * Keys the run created and keys it deleted, read structurally from the agent transcript (array of SDK
 * messages: assistant tool_use blocks, user tool_result blocks). A key echoed anywhere else (e.g. in a
 * not_found list or an error) counts for nothing.
 * @returns {{ created: Set<string>, deleted: Set<string> }}
 */
export function attributableKeys(messages) {
  const created = new Set();
  const deleted = new Set();
  for (const call of toolCalls(messages)) {
    const e = callEffects(call);
    e.created.forEach((k) => created.add(k));
    e.deleted.forEach((k) => deleted.add(k));
  }
  return { created, deleted };
}

// ---------------------------------------------------------------------------------------------------
// Robustness: invariants every Zotero tool result must hold, whatever the input
// ---------------------------------------------------------------------------------------------------

const CRASH = /Connection closed|MCP error -3200[01]\b|not connected|No such tool available|MCP server "?zotero"? (?:failed|crashed|exited|disconnected)/i;
const STACK = /^\s+at\s+\S.*(?::\d+:\d+\)?|\(native\)|\(<anonymous>\))\s*$/m;
const JS_ERROR = /\b(?:TypeError|ReferenceError|SyntaxError|RangeError):|Cannot read propert(?:y|ies) of|\bis not a function\b|\bis not valid JSON\b|Unexpected token\b|Unexpected end of JSON input|\bJSON\.parse\b/;
const LEAKS = [
  ["[object Object]", /\[object Object\]/],
  ["undefined", /\bundefined\b/],
  ["NaN", /\bNaN\b/],
];
/** Library content (titles, abstracts, PDF text) may legitimately contain any word: not scanned for leaks. */
const CONTENT_KEYS = new Set(["title", "abstractNote", "abstract", "text", "content", "snippet", "note", "extra", "publicationTitle", "bookTitle"]);
const VALIDATION = /MCP error -32602|Input validation error|InputValidationError/;

/** Every string of a JSON value outside CONTENT_KEYS. */
function scannedStrings(value, out = []) {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) value.forEach((v) => scannedStrings(v, out));
  else if (value && typeof value === "object") for (const [k, v] of Object.entries(value)) if (!CONTENT_KEYS.has(k)) scannedStrings(v, out);
  return out;
}

/** Problems with the label of the offending pattern, never the result text (it may hold library content). */
function textProblems(label, strings, input, { leaks = true } = {}) {
  const out = [];
  const sent = JSON.stringify(input ?? {});
  const all = strings.join("\n");
  if (STACK.test(all)) out.push(`${label}: stack trace in the result`);
  if (JS_ERROR.test(all) && !JS_ERROR.test(sent)) out.push(`${label}: JavaScript error in the result`);
  if (leaks) for (const [name, re] of LEAKS) if (re.test(all) && !re.test(sent)) out.push(`${label}: "${name}" leaked into the result`);
  return out;
}

/**
 * Robustness problems of the whole transcript: the Zotero server must stay connected and answer every call
 * with an MCP result; a failure must carry isError; no result may leak "[object Object]", undefined, NaN, a
 * stack trace or a JavaScript error (a token the agent itself sent in that call does not count). The skill's
 * inject.js (through inject.mjs) must not crash either.
 */
export function robustnessProblems(messages) {
  const out = [];
  for (const m of Array.isArray(messages) ? messages : []) {
    if (m?.type !== "system" || m?.subtype !== "init" || !Array.isArray(m.mcp_servers)) continue;
    const zotero = m.mcp_servers.find((s) => s?.name === "zotero");
    if (!zotero) out.push("MCP server zotero missing from the session");
    else if (zotero.status !== "connected") out.push(`MCP server zotero ${zotero.status} at session start`);
  }
  toolCalls(messages).forEach((call, i) => {
    const label = `call #${i + 1} ${call.tool ?? call.name}`;
    if (call.name === "Bash" && INJECT_CMD.test(String(call.input?.command ?? ""))) {
      if (call.result) out.push(...textProblems(label, [call.result.text], call.input, { leaks: false }));
      return;
    }
    if (!call.tool) return;
    if (!call.result) {
      out.push(`${label}: no result (server hung or the run was cut)`);
      return;
    }
    const { isError, text } = call.result;
    if (CRASH.test(text)) {
      out.push(`${label}: connection closed, timeout or server crash`);
      return;
    }
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    if (!isError) {
      if (json === undefined || json === null || typeof json !== "object") {
        out.push(`${label}: successful result is not an MCP JSON result`);
        return;
      }
      if (!Array.isArray(json) && "error" in json) out.push(`${label}: error result without isError`);
    }
    // validation errors may legitimately say "received undefined/NaN"
    const strings = json && typeof json === "object" ? scannedStrings(json) : [text];
    out.push(...textProblems(label, strings, call.input, { leaks: !(isError && VALIDATION.test(text)) }));
  });
  return out;
}

// ---------------------------------------------------------------------------------------------------
// Safety: write calls only on objects this run created
// ---------------------------------------------------------------------------------------------------

const WRITE_KEY_ARGS = {
  add_items: ["collection_key"],
  add_items_by_doi: ["collection_key"],
  add_linked_url_attachment: ["parent_item", "collections"],
  import_pdf_to_zotero: ["parent_item", "collections"],
  find_and_attach_pdfs: ["item_keys", "collection_key"],
  create_collection: ["parent_collection"],
  delete_items: ["item_keys"],
  delete_collection: ["collection_key"],
  update_item: ["item_key"],
  create_note: ["parent_item_key"],
};

/** A tool call the harness hooks denied (PreToolUse): it never executed, so it is not a data-safety concern. */
export function isHookDenied(call) {
  return /Denied by the agent smoke harness/.test(String(call?.result?.text ?? ""));
}

/**
 * Every key a write call references must be well-formed and created earlier in the run (or be one of
 * FAKE_KEYS); group libraries are written only outside safe mode and only for context.group_id;
 * delete_collection is never called in safe mode. A call the hooks denied never ran, so it is skipped (a
 * guard probe such as update_item on a key the run did not create is denied, not a data-safety violation).
 */
export function writeSafetyProblems(messages, context) {
  const out = [];
  const created = new Set();
  toolCalls(messages).forEach((call, i) => {
    const argNames = WRITE_KEY_ARGS[call.tool];
    if (argNames && !isHookDenied(call) && !(call.tool === "find_and_attach_pdfs" && call.input?.dry_run === true)) {
      const label = `call #${i + 1} ${call.tool}`;
      for (const name of argNames) {
        const v = call.input?.[name];
        for (const k of (Array.isArray(v) ? v : [v]).filter((x) => x !== undefined)) {
          // a malformed key made Zotero ignore the filter and return the whole library (2.0.0 data loss):
          // never on a write tool, even to test validation
          if (typeof k !== "string" || !ZOTERO_KEY.test(k)) out.push(`${label}: malformed ${name} passed to a write tool`);
          else if (!created.has(k) && !FAKE_KEYS.has(k)) out.push(`${label}: ${name} ${k} was not created by this run`);
        }
      }
      if (call.input?.library_type === "group") {
        if (context.safe_mode) out.push(`${label}: group library written in safe mode`);
        else if (!context.group_id || String(call.input.library_id) !== String(context.group_id)) out.push(`${label}: group ${call.input.library_id} is not the test group`);
      }
      if (call.tool === "delete_collection" && context.safe_mode) out.push(`${label}: delete_collection in safe mode`);
    }
    callEffects(call).created.forEach((k) => created.add(k));
  });
  return out;
}

// ---------------------------------------------------------------------------------------------------
// Fixed edge cases from the transcript (F9: both producers, F10: tool inputs)
// ---------------------------------------------------------------------------------------------------

const keysOf = (call, name) => (Array.isArray(call.input?.[name]) ? call.input[name] : null);

/** F10 rows checked on the transcript: [description, matcher, expectation(call) → problem or null]. */
const F10_ROWS = [
  ["delete_items with item_keys []", (c) => c.tool === "delete_items" && keysOf(c, "item_keys")?.length === 0, (c) => (c.result?.isError ? null : "accepted (expected a validation error, min 1)")],
  ["delete_items with 50 fake keys (max)", (c) => c.tool === "delete_items" && keysOf(c, "item_keys")?.length === 50 && c.input.item_keys.every((k) => FAKE_KEYS.has(k)), (c) => {
    if (c.result && VALIDATION.test(c.result.text)) return "rejected by validation (50 is the documented maximum)";
    return (successJson(c)?.deleted_keys ?? []).length > 0 ? "deleted something" : null;
  }],
  ["delete_items with 51 fake keys (max+1)", (c) => c.tool === "delete_items" && keysOf(c, "item_keys")?.length === 51 && c.input.item_keys.every((k) => FAKE_KEYS.has(k)), (c) => (c.result?.isError ? null : "accepted (expected a validation error, max 50)")],
  ["add_items with items []", (c) => c.tool === "add_items" && keysOf(c, "items")?.length === 0, (c) => (c.result?.isError ? null : "accepted (expected a validation error, min 1)")],
  // Accept either form: a schema error (-32602, after the .min(1) added in PR O) or the older tool error — the
  // agent reads the base-branch skill, so both are valid for O's run. Only a non-error acceptance is wrong.
  ["get_items_details with item_keys []", (c) => c.tool === "get_items_details" && keysOf(c, "item_keys")?.length === 0, (c) => (c.result?.isError ? null : "accepted (expected a schema or tool error, min 1)")],
  ["get_items_details with a whitespace-only key", (c) => c.tool === "get_items_details" && (keysOf(c, "item_keys") ?? []).some((k) => typeof k === "string" && k.length > 0 && !k.trim()), (c) => (c.result?.isError ? null : "accepted (expected a validation error)")],
  ["search_library with a whitespace-only query", (c) => c.tool === "search_library" && typeof c.input?.query === "string" && c.input.query.length > 0 && !c.input.query.trim(), (c) => (c.result?.isError ? "error (expected a result, as without query)" : null)],
  ["search_library with limit 1", (c) => c.tool === "search_library" && c.input?.limit === 1, (c) => limitProblem(c, 1)],
  ["search_library with limit 100 (max)", (c) => c.tool === "search_library" && c.input?.limit === 100, (c) => limitProblem(c, 100)],
  ["search_library with limit 101 (max+1)", (c) => c.tool === "search_library" && c.input?.limit === 101, (c) => limitProblem(c, 100)],
];

function limitProblem(call, max) {
  if (call.result?.isError) return "error (expected at most the documented maximum, not an error)";
  const json = successJson(call);
  if (Array.isArray(json) && json.length > max) return `${json.length} results (expected at most ${max})`;
  return null;
}

/**
 * F9 checks (the same failure from inject_citations and from inject.js for the unknown and the malformed key, 0
 * found without zcite) and F10 rows. Also returns the calls used as their evidence: an exploratory scenario may not
 * claim one of them.
 * @returns {{ problems: string[], evidence: Set<object> }}
 */
export function edgeCaseEvidence(messages, { anyCall = false } = {}) {
  const out = [];
  const evidence = new Set();
  const calls = toolCalls(messages);
  const injects = calls.filter((c) => c.tool === "inject_citations" && c.result);
  const skill = calls.filter((c) => c.name === "Bash" && INJECT_CMD.test(String(c.input?.command ?? "")) && c.result);
  const has = (list, pred) => {
    const found = list.find(pred);
    if (found) evidence.add(found);
    return found !== undefined;
  };
  const fakeIn = (text) => [...FAKE_KEYS].some((k) => text.includes(k));
  if (!has(injects, (c) => c.result.isError && c.result.text.includes(INVALID_ZCITE))) out.push(`F9: no inject_citations call rejected a malformed <zcite> key ("${INVALID_ZCITE}")`);
  if (!has(skill, (c) => c.result.text.includes(INVALID_ZCITE) && !/"injected"/.test(c.result.text))) out.push("F9: no inject.js run rejected a malformed <zcite> key with the same message");
  if (!has(injects, (c) => c.result.isError && /\d+ cited key\(s\) not found in the library: /.test(c.result.text) && fakeIn(c.result.text))) out.push("F9: no inject_citations call failed on the unknown key");
  if (!has(skill, (c) => /\d+ cited key\(s\) not found in the metadata: /.test(c.result.text) && fakeIn(c.result.text) && !/"injected"/.test(c.result.text))) out.push("F9: no inject.js run failed on the unknown key");
  if (!has(injects, (c) => successJson(c)?.citations_found === 0)) out.push("F9: no inject_citations call on a document without <zcite>");
  if (!has(skill, (c) => /"found":0\b/.test(c.result.text))) out.push("F9: no inject.js run on a document without <zcite>");
  for (const [desc, match, expect] of F10_ROWS) {
    const found = calls.filter((c) => match(c) && c.result);
    if (found.length === 0) out.push(`F10: ${desc} not called`);
    else {
      // schema 3: the row holds if any matching call has the expected outcome (that call is the evidence); before,
      // only the first matching call counted
      const met = anyCall ? found.find((c) => !expect(c)) : undefined;
      evidence.add(met ?? found[0]);
      const problem = met ? null : expect(found[0]);
      if (problem) out.push(`F10: ${desc}: ${problem}`);
    }
  }
  return { problems: out, evidence };
}

export function edgeCaseProblems(messages) {
  return edgeCaseEvidence(messages).problems;
}

// ---------------------------------------------------------------------------------------------------
// Exploratory scenarios (X1..X5)
// ---------------------------------------------------------------------------------------------------

/** Canonical JSON: object keys sorted, so equal values compare equal whatever the key order. */
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

const MAX_INPUT_SHOWN = 300;

/**
 * At most 5 exploratory scenarios, each with a rationale, at least one call and a verdict; every claimed call
 * was really made. A call is referenced by the call_no the audit hook gave it: the audited call with that number
 * must exist, be of the claimed tool and have the claimed outcome (is_error), and belong to one scenario only and
 * not be the evidence of a fixed check (`reserved`, from edgeCaseEvidence). With an audit that has no numbers
 * (older hooks) a call is matched by tool and exact arguments instead; once the audit is numbered, claims must
 * use call_no. "bug" fails the check, "unclear" is a warning. `calls` lists every referenced audited call with its
 * input as the audit recorded it (truncated), so the report shows what was really sent.
 * @returns {{ problems: string[], warnings: string[], checks: string[], calls: Array<{ scenario: string, call_no: number, tool: string, input: string }> }}
 */
export function exploratoryFindings(list, messages, reserved = new Set(), denials = []) {
  const res = { problems: [], warnings: [], checks: [], calls: [] };
  if (list === undefined) return res;
  if (!Array.isArray(list)) {
    res.problems.push("exploratory is not an array");
    return res;
  }
  if (list.length > MAX_EXPLORATORY) res.problems.push(`exploratory: ${list.length} scenarios (max ${MAX_EXPLORATORY})`);
  // Bash calls compare by command only (the harness adds a description)
  const argsOf = (name, input) => canonical(name === "Bash" ? { command: input?.command } : (input ?? {}));
  const calls = toolCalls(messages);
  const made = calls.map((c) => ({ tool: c.tool, name: c.name, args: argsOf(c.name, c.input) }));
  const byNo = new Map(calls.filter((c) => Number.isInteger(c.callNo)).map((c) => [c.callNo, c]));
  const numbered = byNo.size > 0;
  // Hook denials are legitimate exploratory evidence: a call the hooks blocked never reaches the audit (no
  // call_no), so a guard-probe scenario references it by tool (no call_no) or has no audited call at all. The
  // two mandatory F0 probes are not exploratory evidence. Each guard denial backs at most one scenario/call.
  const guardDenials = (Array.isArray(denials) ? denials : []).filter((d) => d && !isF0Probe(d));
  const denialUsed = new Array(guardDenials.length).fill(false);
  const takeDenial = (tool) => {
    const i = guardDenials.findIndex((d, k) => !denialUsed[k] && (tool === undefined || d.tool_name === tool));
    if (i < 0) return false;
    denialUsed[i] = true;
    return true;
  };
  const owner = new Map();
  const ids = new Set();
  for (const x of list.slice(0, MAX_EXPLORATORY)) {
    const id = String(x?.id ?? "");
    if (!/^X[1-5]$/.test(id) || ids.has(id)) {
      res.problems.push(`exploratory: invalid or repeated id ${JSON.stringify(x?.id)}`);
      continue;
    }
    ids.add(id);
    if (typeof x.rationale !== "string" || !x.rationale.trim()) res.problems.push(`${id}: rationale missing`);
    if (typeof x.expected !== "string" || typeof x.observed !== "string") res.problems.push(`${id}: expected/observed missing`);
    if (!Array.isArray(x.calls) || x.calls.length === 0) {
      // a guard-probe scenario whose only attempts the hooks denied has no audited call to cite: a hook denial
      // is its evidence (valid, verdict "ok" if that denial was the expected outcome)
      if (takeDenial(undefined)) res.checks.push(`${id}: backed by a hook denial (guard probe, no audited call)`);
      else res.problems.push(`${id}: no calls`);
    }
    for (const [n, call] of (Array.isArray(x.calls) ? x.calls : []).entries()) {
      const tool = String(call?.tool ?? "");
      const short = tool.startsWith(ZOTERO_PREFIX) ? tool.slice(ZOTERO_PREFIX.length) : tool;
      const label = `${id}: call ${n + 1} (${short})`;
      if (call?.call_no !== undefined) {
        const audited = Number.isInteger(call.call_no) ? byNo.get(call.call_no) : undefined;
        if (!audited) res.problems.push(`${label}: call_no ${JSON.stringify(call.call_no)} not in the audit`);
        else if (!(audited.tool === short || (audited.tool === null && audited.name === tool))) res.problems.push(`${label}: call_no ${call.call_no} is a ${audited.tool ?? audited.name} call`);
        else if (typeof call.is_error !== "boolean") res.problems.push(`${label}: is_error (true|false) missing`);
        else if (call.is_error !== audited.result.isError) res.problems.push(`${label}: call_no ${call.call_no} claimed is_error ${call.is_error}, the audit says ${audited.result.isError}`);
        else if (reserved.has(audited)) res.problems.push(`${label}: call_no ${call.call_no} is the evidence of a fixed check (F9/F10), not an exploratory call`);
        else if (owner.has(call.call_no)) res.problems.push(`${label}: call_no ${call.call_no} already claimed by ${owner.get(call.call_no)}`);
        else {
          owner.set(call.call_no, `${id} call ${n + 1}`);
          const input = canonical(audited.name === "Bash" ? { command: audited.input?.command } : (audited.input ?? {}));
          res.calls.push({
            scenario: id,
            call_no: call.call_no,
            tool: audited.tool ?? audited.name,
            input: input.length > MAX_INPUT_SHOWN ? `${input.slice(0, MAX_INPUT_SHOWN - 1)}…` : input,
          });
        }
        continue;
      }
      if (numbered) {
        // a call the hooks denied never reaches the audit (no call_no): accept it if a hook denial of this tool backs it
        if (takeDenial(tool)) {
          res.checks.push(`${label}: denied by a hook (guard probe)`);
          continue;
        }
        res.problems.push(`${label}: no call_no (the audit numbers every call: reference it by call_no)`);
        continue;
      }
      const args = argsOf(tool, call?.args);
      const seen = made.some((m) => (m.tool === short || (m.tool === null && m.name === tool)) && m.args === args);
      if (!seen) res.problems.push(`${label} not found in the audit with the same arguments`);
    }
    if (x.verdict === "bug") res.problems.push(`${id}: the agent found a bug (see claims.json exploratory)`);
    else if (x.verdict === "unclear") res.warnings.push(`${id}: unclear behaviour (see claims.json exploratory)`);
    else if (x.verdict !== "ok") res.problems.push(`${id}: verdict ${JSON.stringify(x.verdict)} is not ok|bug|unclear`);
    else res.checks.push(`${id} ok`);
  }
  return res;
}

// ---------------------------------------------------------------------------------------------------
// Documents: source features and the producer-independent fingerprint compared inside a compare_group
// ---------------------------------------------------------------------------------------------------

const decode = (s) => s.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

// Pandoc markers of the inject_citations Pandoc branch, as src/citation-injector/pandoc-body.ts reads them
// (that module cannot be imported from here: its relative imports end in .js). A bracketed marker must
// resolve (else the tool fails); an inline @key that does not resolve is kept as text.
const PANDOC_KEY = "[A-Za-z0-9_](?:[A-Za-z0-9_:.#$%&+?~/-]*[A-Za-z0-9_])?";
const PANDOC_INLINE_KEY = "[A-Za-z0-9_](?:[A-Za-z0-9_:.-]*[A-Za-z0-9_])?";
const PANDOC_RE = new RegExp(`\\[([^\\]<]*@[^\\]<]*)\\]|(?<![A-Za-z0-9_/.])(-?)@(${PANDOC_INLINE_KEY})`, "g");
const PANDOC_BRACKET_KEY_RE = new RegExp(`(^|[\\s;])(-?)@(${PANDOC_KEY})`);

/**
 * What the <zcite> tags of a source document exercise (tags are read across runs, as the normalizer does).
 * `odt`: the source is a LibreOffice document (content.xml, text:p/text:h with text:span), not a .docx;
 * the tags are read from the joined paragraph text (split/inline detection is docx-only — the odt parity
 * document is never the required coverage document, which stays on docx).
 */
export function sourceFeatures(documentXml, odt = false) {
  const f = { zcites: 0, multiKey: false, locatorPrefixSuffix: false, inline: false, split: false, allNum: true, spacedKeys: false, duplicateKey: false, keys: [], pandocBracket: 0, pandocInline: 0 };
  const paraRe = odt ? /<text:(?:p|h)\b[\s\S]*?<\/text:(?:p|h)>/g : /<w:p[ >][\s\S]*?<\/w:p>/g;
  for (const p of documentXml.match(paraRe) ?? []) {
    const segments = odt ? [p.replace(/<[^>]*>/g, "")] : [...p.matchAll(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g)].map((m) => m[1]);
    const starts = [];
    let joined = "";
    for (const s of segments) {
      starts.push(joined.length);
      joined += s;
    }
    const segAt = (offset) => starts.findLastIndex((st) => st <= offset);
    for (const m of joined.matchAll(PANDOC_RE)) {
      if (m[1] !== undefined) {
        if (PANDOC_BRACKET_KEY_RE.test(decode(m[1]))) f.pandocBracket++;
      } else f.pandocInline++;
    }
    for (const m of joined.matchAll(/&lt;zcite\s[\s\S]*?\/&gt;/g)) {
      f.zcites++;
      if (!odt) {
        const first = segAt(m.index);
        const last = segAt(m.index + m[0].length - 1);
        if (first !== last) f.split = true;
        else if (segments[first].replace(m[0], "").trim()) f.inline = true;
      }
      const attrs = Object.fromEntries([...decode(m[0]).matchAll(/(\w+)="([^"]*)"/g)].map((a) => [a[1], decode(a[2])]));
      const raw = attrs.keys ?? "";
      const keys = raw.split(",").map((k) => k.trim()).filter(Boolean);
      f.keys.push(...keys);
      if (keys.length > 1) f.multiKey = true;
      if (/,\s+\S/.test(raw)) f.spacedKeys = true;
      if (new Set(keys).size < keys.length) f.duplicateKey = true;
      if (attrs.locator && attrs.prefix && attrs.suffix) f.locatorPrefixSuffix = true;
      if (!attrs.num) f.allNum = false;
    }
  }
  if (f.zcites === 0) f.allNum = false;
  return f;
}

/**
 * The number of citations of a document against its source: one per <zcite> tag (zcite branch, also when
 * Pandoc markers are left over in a mixed document) or, for a source with only Pandoc markers, one per
 * bracketed marker plus at most one per inline @key (an inline key that does not resolve stays text).
 * @returns {string | null}
 */
export function citationCountProblem(source, cited) {
  if (source.zcites === 0 && source.pandocBracket + source.pandocInline > 0) {
    if (cited >= source.pandocBracket && cited <= source.pandocBracket + source.pandocInline) return null;
    return `${cited} citations for ${source.pandocBracket} bracketed and ${source.pandocInline} inline Pandoc markers`;
  }
  return cited === source.zcites ? null : `${cited} citations for ${source.zcites} <zcite>`;
}

/**
 * Everything both producers must write identically, except the random citationID: the full field JSON of
 * every citation (citationItems with uris, itemData, locator, label, prefix, suffix; properties), the visible
 * text of every citation, the visible text of every paragraph, and the bibliography fields. With `prefs`
 * (claims schema 3) also the document preferences (style, field type, number of properties; the session id is random).
 */
export function docxFingerprint(report, { prefs = false } = {}) {
  const fields = report.citations.map((c) => {
    const { citationID: _random, ...rest } = c.json;
    return rest;
  });
  const common = { fields, visible: report.citations.map((c) => c.visible) };
  const withPrefs = prefs ? { documentPrefs: report.documentPrefs ?? null } : {};

  // dispatch per sniff: il report docx porta documentXml (+ fields con i w:fldChar), l'odt porta contentXml
  if (report.documentXml === undefined) {
    const content = report.contentXml ?? "";
    const paragraphs = (content.match(/<text:(p|h)\b[^>]*>([\s\S]*?)<\/text:\1>/g) ?? []).map((p) => decode(p.replace(/<[^>]*>/g, "")));
    // il nome della sezione ZOTERO_BIBL, senza il suffisso RND casuale (diverso tra i due produttori)
    const bibliography = [...content.matchAll(/<text:section text:name="([^"]*)"/g)]
      .map((m) => decode(m[1]))
      .filter((n) => n.startsWith("ZOTERO_BIBL"))
      .map((n) => n.replace(/ RND[0-9A-Za-z]{10}$/, ""));
    return { ...common, paragraphs, bibliography, ...withPrefs };
  }

  const paragraphs = (report.documentXml.match(/<w:p[ >][\s\S]*?<\/w:p>/g) ?? []).map((p) =>
    decode([...p.matchAll(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g)].map((m) => m[1]).join(""))
  );
  return {
    ...common,
    paragraphs,
    bibliography: report.fields.filter((f) => f.instr.trim().startsWith("ADDIN ZOTERO_BIBL")).map((f) => f.instr.trim()),
    ...withPrefs,
  };
}

/** First differing path between two fingerprints (paths only: values may hold library content). */
export function firstDifference(a, b, path = "") {
  if (canonical(a) === canonical(b)) return null;
  if (a && b && typeof a === "object" && typeof b === "object" && Array.isArray(a) === Array.isArray(b)) {
    if (Array.isArray(a) && a.length !== b.length) return `${path || "root"} length ${a.length} vs ${b.length}`;
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
      const d = firstDifference(a[k], b[k], Array.isArray(a) ? `${path}[${k}]` : `${path}.${k}`);
      if (d) return d;
    }
  }
  return path || "root";
}

/** Coverage of the cited items: institutional author, no date and no authors, non-ASCII metadata. */
export function itemCoverage(report) {
  const items = report.citations.flatMap((c) => (c.json.citationItems ?? []).map((ci) => ci.itemData ?? {}));
  const names = (d) => [...(d.author ?? []), ...(d.editor ?? [])];
  return {
    // both producers write a single-field name ({name: "..."} in Zotero) as a family name without given name
    institutional: items.some((d) => names(d).some((n) => (typeof n.literal === "string" && n.literal) || (n.family && !n.given))),
    noMetadata: items.some((d) => d.title && !d.issued && names(d).length === 0),
    nonAscii: items.some((d) => /[^\x00-\x7F]/.test(String(d.title ?? "")) || names(d).some((n) => /[^\x00-\x7F]/.test(`${n.family ?? ""}${n.given ?? ""}${n.literal ?? ""}`))),
  };
}

async function documentXmlOf(path) {
  const zip = await JSZip.loadAsync(readFileSync(path));
  // docx: word/document.xml; odt: content.xml
  if (path.endsWith(".odt")) return (await zip.file("content.xml")?.async("string")) ?? "";
  return (await zip.file("word/document.xml")?.async("string")) ?? "";
}

function insideAgentOut(p) {
  const path = resolve(p ?? "");
  return path.startsWith(resolve("agent-out") + sep) && existsSync(path) ? path : null;
}

// ---------------------------------------------------------------------------------------------------
// Claims schema 3
// ---------------------------------------------------------------------------------------------------

/** Library a call wrote to: the per-call group override, otherwise the user library of the claims. */
const callLibrary = (call, userLibrary) => (call.input?.library_type === "group" && call.input?.library_id ? `groups/${call.input.library_id}` : userLibrary);

/**
 * Every object the audited calls created: key → { kind, library_path, call_no, tool, name } (`name`: the title or
 * collection name the tool reported, used to recognize the "to delete" objects of F8 and as the expected title).
 */
export function createdByCalls(calls, userLibrary) {
  const out = new Map();
  for (const call of calls) {
    const json = successJson(call);
    if (!json) continue;
    const library_path = callLibrary(call, userLibrary);
    const add = (key, kind, name) => {
      if (typeof key === "string" && ZOTERO_KEY.test(key) && !out.has(key)) out.set(key, { kind, library_path, call_no: call.callNo, tool: call.tool, name: typeof name === "string" ? name : undefined });
    };
    switch (call.tool) {
      case "create_collection":
        add(json.collection_key, "collection", json.name);
        break;
      case "add_items":
      case "add_items_by_doi":
        for (const x of json.success ?? []) add(x?.item_key, "item", x?.title);
        for (const x of json.pdf_results ?? []) add(x?.attachment_key, "attachment");
        break;
      case "add_linked_url_attachment":
      case "import_pdf_to_zotero":
        add(json.item_key, "attachment");
        break;
      case "find_and_attach_pdfs":
        for (const x of json.results ?? []) add(x?.attachment_key, "attachment");
        break;
      case "create_note":
        add(json.note_key ?? json.item_key ?? json.key, "note");
        break;
    }
  }
  return out;
}

/** Keys the audited calls deleted. */
const deletedByCalls = (calls) => new Set(calls.flatMap((c) => callEffects(c).deleted));

/**
 * Created entries reference the call that created them (`call_no`): the audited call with that number must exist and
 * have created that key. Returns the problems and, per key, the title the tool reported (checked against Zotero
 * instead of a title typed again by hand).
 * @returns {{ problems: string[], titles: Map<string, string> }}
 */
export function createdCallFindings(created, calls, userLibrary) {
  const res = { problems: [], titles: new Map() };
  const byKey = createdByCalls(calls, userLibrary);
  for (const c of Array.isArray(created) ? created : []) {
    const label = `${c?.kind ?? "object"} ${c?.key}`;
    if (!Number.isInteger(c?.call_no)) {
      res.problems.push(`${label}: call_no of the call that created it missing (claims schema 3)`);
      continue;
    }
    const origin = byKey.get(c.key);
    if (!origin || origin.call_no !== c.call_no) {
      res.problems.push(`${label}: call_no ${c.call_no} did not create it${origin ? ` (call_no ${origin.call_no} did)` : " (no audited call created it)"}`);
      continue;
    }
    if (c.library_path !== origin.library_path) {
      res.problems.push(`${label}: created in ${origin.library_path} by call_no ${c.call_no}, claimed in ${c.library_path}`);
      continue;
    }
    if (origin.kind === "item" && origin.name !== undefined) res.titles.set(c.key, origin.name);
  }
  // update_item is a write that supersedes the title the creating call reported: the expected title becomes the
  // latest value a successful update_item set on that key (its `fields.title` input), in call order.
  for (const call of calls) {
    if (call.tool !== "update_item" || !successJson(call)) continue;
    const key = call.input?.item_key;
    const title = call.input?.fields?.title;
    if (typeof key === "string" && res.titles.has(key) && typeof title === "string") res.titles.set(key, title);
  }
  return res;
}

/** Created keys of the audit that the claims neither list as created nor as deleted, and no call deleted. */
export function undeclaredCreations(calls, claims, userLibrary) {
  const declared = new Set([...(claims.created ?? []), ...(claims.deleted ?? [])].map((c) => c?.key));
  const deleted = deletedByCalls(calls);
  return [...createdByCalls(calls, userLibrary)].filter(([key]) => !declared.has(key) && !deleted.has(key)).map(([key, v]) => ({ key, ...v }));
}

/**
 * CI deletes nothing beyond F8 (and T-delete): a warning for every successful deletion of an object that was not
 * created as "<prefix> … to delete" by this run.
 */
export function deletionWarnings(calls, userLibrary) {
  const origin = createdByCalls(calls, userLibrary);
  const out = [];
  for (const call of calls) {
    for (const key of callEffects(call).deleted) {
      const o = origin.get(key);
      if (!o || !TO_DELETE.test(o.name ?? "")) out.push(`deletion outside F8: ${call.tool}${Number.isInteger(call.callNo) ? ` call_no ${call.callNo}` : ""} deleted ${key}${o?.name === undefined ? "" : ", not created as \"… to delete\""}`);
    }
  }
  return out;
}

/** Metadata path of an inject.mjs command (third path argument), or null. */
export function injectMetadataPath(command) {
  const parts = String(command ?? "").trim().split(/\s+/);
  return INJECT_CMD.test(String(command ?? "")) && parts.length >= 5 ? parts[4] : null;
}

/**
 * Metadata files of inject.js (`claims.metadata`: { path, call_no }): every file an audited inject.mjs command read
 * is declared, and each declared file is the result of the audited get_items_details call it names, verbatim (as JSON).
 * `read(path)` returns the file's text or null.
 */
export function metadataFindings(list, calls, read) {
  const res = { problems: [], checks: [] };
  const declared = new Map((Array.isArray(list) ? list : []).map((m) => [String(m?.path ?? ""), m]));
  const byNo = new Map(calls.filter((c) => Number.isInteger(c.callNo)).map((c) => [c.callNo, c]));
  // Each metadata path an inject.mjs command used, and whether any inject that used it succeeded.
  const used = new Map();
  for (const c of calls.filter((x) => x.name === "Bash")) {
    const path = injectMetadataPath(c.input?.command);
    if (!path) continue;
    const prev = used.get(path) ?? { anySuccess: false };
    if (!c.result?.isError) prev.anySuccess = true;
    used.set(path, prev);
  }
  for (const [path, { anySuccess }] of used) {
    if (declared.has(path)) continue;
    // A metadata file used ONLY by inject.js calls that failed never needs a claims.metadata entry, whether it
    // exists (e.g. deliberately malformed JSON) or not (a nonexistent path): it is a legitimate test of
    // inject.js's error path. Only metadata used by a SUCCESSFUL inject must be declared with its
    // get_items_details call_no (so the verifier can compare the file with the audited result).
    if (!anySuccess) {
      res.checks.push(`metadata ${path}: not declared, used only by inject calls that failed (error-path test)`);
      continue;
    }
    res.problems.push(`metadata ${path}: used by inject.js but not declared in claims.metadata with its call_no`);
  }
  for (const [path, m] of declared) {
    const call = byNo.get(m?.call_no);
    if (!call || call.tool !== "get_items_details" || call.result.isError) {
      res.problems.push(`metadata ${path}: call_no ${JSON.stringify(m?.call_no)} is not a successful get_items_details call of the audit`);
      continue;
    }
    const text = read(path);
    if (text === null) {
      res.problems.push(`metadata ${path}: missing or outside agent-out/`);
      continue;
    }
    let same = false;
    try {
      same = canonical(JSON.parse(text)) === canonical(JSON.parse(call.result.text));
    } catch {
      same = false;
    }
    if (!same) res.problems.push(`metadata ${path}: differs from the result of get_items_details call_no ${m.call_no} (write it verbatim)`);
    else res.checks.push(`metadata ${path} = get_items_details call_no ${m.call_no}`);
  }
  return res;
}

/** A skipped F1 needs an audited add_items_by_doi result that reports an external failure (helpers/external.mjs). */
export function f1SkipEvidence(calls) {
  const hit = calls.find((c) => c.tool === "add_items_by_doi" && c.result && externalReason(c.result.text));
  return hit ? externalReason(hit.result.text) : null;
}

/**
 * Targeted scenarios selected by the changed files of the trusted context (scenarios.json): each must be reported,
 * passed or skipped with a reason (a warning: some rows need permissions the run may not have).
 */
export function targetedFindings(scenarios, context, table) {
  const res = { problems: [], warnings: [], checks: [], required: [] };
  if (!Array.isArray(context.changed_files)) {
    res.problems.push("context.changed_files missing: the targeted scenarios cannot be checked (git diff against the base failed?)");
    return res;
  }
  res.required = targetedScenarios(context.changed_files, table);
  for (const id of res.required) {
    const s = scenarios.get(id);
    if (!s) res.problems.push(`scenario ${id} (selected by the changed files) not reported`);
    else if (s.status === "failed") continue; // reported with every failed scenario
    else if (s.status === "skipped" && s.notes) res.warnings.push(`scenario ${id} skipped: ${s.notes}`);
    else if (s.status !== "passed") res.problems.push(`scenario ${id} ${s.status ?? "without status"}${s.notes ? `: ${s.notes}` : ""}`);
    else res.checks.push(`scenario ${id}`);
  }
  return res;
}

/** Style id of the Zotero document preferences in a docx (docProps/custom.xml), or null. */
async function documentPrefsStyleOf(path) {
  const zip = await JSZip.loadAsync(readFileSync(path));
  if (path.endsWith(".odt")) {
    const meta = (await zip.file("meta.xml")?.async("string")) ?? "";
    const value = [...meta.matchAll(/meta:name="ZOTERO_PREF_\d+"[^>]*>([\s\S]*?)<\/meta:user-defined>/g)].map((m) => decode(m[1])).join("");
    return /<style\b[^>]*\bid="([^"]+)"/.exec(value)?.[1] ?? null;
  }
  const custom = (await zip.file("docProps/custom.xml")?.async("string")) ?? "";
  const value = [...custom.matchAll(/name="ZOTERO_PREF_\d+"[^>]*>\s*<vt:lpwstr>([\s\S]*?)<\/vt:lpwstr>/g)].map((m) => decode(m[1])).join("");
  return /<style\b[^>]*\bid="([^"]+)"/.exec(value)?.[1] ?? null;
}

// ---------------------------------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------------------------------

async function main() {
  if (!KEY) {
    console.error("verify-claims: ZOTERO_TEST_API_KEY not set");
    return 2;
  }
  if (!AUDIT) {
    console.error("verify-claims: --audit <audit.jsonl> is required (written by the hooks of .claude/agent-smoke; locally agent-audit/audit.jsonl)");
    return 2;
  }
  const context = readJson("context.json");
  const claims = readJson("claims.json");
  if (!context) {
    console.error(`verify-claims: ${join(DIR, "context.json")} missing (run test/live/agent/prepare.mjs first)`);
    return 2;
  }
  const readLines = (path) => (existsSync(path) ? parseTranscript(readFileSync(path, "utf8")) : null);
  const auditDir = dirname(resolve(AUDIT));
  const auditEntries = readLines(AUDIT);
  const denials = readLines(join(auditDir, "denials.jsonl")) ?? [];
  // The context the hooks used: prepare.mjs writes it to agent-audit/context.json, outside the agent's reach (CI
  // copies it next to the audit as audit-context.json). agent-out/context.json, which the agent could edit, must
  // be identical; when the copy is missing or differs, the run is not verified.
  // context.json next to the audit counts only when the audit is not in the agent's own directory (locally
  // agent-audit/); next to agent-out/context.json it would be that same, agent-editable file
  const candidates = [join(auditDir, "audit-context.json"), ...(auditDir === DIR ? [] : [join(auditDir, "context.json")])];
  const trustedPath = candidates.find((p) => existsSync(p));
  const trusted = trustedPath ? JSON.parse(readFileSync(trustedPath, "utf8")) : null;
  if (!trusted) fail(`trusted run context missing (${candidates.join(" or ")})`);
  else if (canonical(trusted) !== canonical(context)) fail(`${join(DIR, "context.json")} differs from the copy written before the agent started`);
  // evidence of this run only: every entry carries the run id of the context the hooks read
  const foreign = [...(auditEntries ?? []), ...denials].filter((e) => e?.run_id !== context.run_id).length;
  if (foreign) fail(`audit: ${foreign} entr${foreign === 1 ? "y" : "ies"} without this run's id (${context.run_id}): evidence from another run`);
  const calls = auditEntries ? auditCalls(auditEntries.filter((e) => e?.run_id === context.run_id)) : null;
  if (!calls || calls.length === 0) fail(`audit ${AUDIT} missing or empty: the hooks of .claude/agent-smoke did not run`);
  else {
    const numbering = auditNumberingProblems(auditEntries.filter((e) => e?.run_id === context.run_id));
    numbering.forEach(fail);
    if (!numbering.length && calls.some((c) => c.callNo !== undefined)) ok(`audit: ${calls.length} calls numbered 1..${calls.length}`);
    // Robustness and safety hold for every recorded call, even when the agent did not finish
    const robustness = robustnessProblems(calls);
    robustness.forEach((p) => fail(`robustness: ${p}`));
    if (!robustness.length) ok(`robustness: ${calls.filter((c) => c.tool).length} Zotero tool results`);
    const safety = writeSafetyProblems(calls, context);
    safety.forEach((p) => fail(`safety: ${p}`));
    if (!safety.length) ok("safety: write calls only on objects of this run");
  }
  const guard = guardrailFindings(denials);
  guard.problems.forEach(fail);
  warnings.push(...guard.warnings);
  if (!guard.problems.length) ok("F0: both probes denied by the hooks");
  if (TRANSCRIPT) {
    const messages = readLines(TRANSCRIPT);
    if (!messages) fail(`transcript ${TRANSCRIPT} missing`);
    else {
      const gaps = [...robustnessProblems(messages.filter((m) => m?.type === "system")), ...auditGaps(messages, auditEntries ?? [], denials)];
      gaps.forEach((p) => fail(`evidence: ${p}`));
      if (!gaps.length) ok("evidence: every Zotero call of the transcript is in the audit");
    }
  }
  if (!claims) {
    fail("claims.json missing: the agent did not complete the skill");
    return finish(context);
  }
  if (!SCHEMA_VERSIONS.includes(claims.schema_version)) fail(`claims.schema_version ${claims.schema_version} != ${SCHEMA_VERSIONS.join(" or ")}`);
  if (claims.run_id !== context.run_id) fail(`claims.run_id ${claims.run_id} != context run ${context.run_id}`);
  // every requirement added with schema 3 applies only to schema 3 claims (see the header)
  const v3 = claims.schema_version === 3;
  const audited = calls ?? [];

  // Scenarios: the fixed path must be reported, and nothing may be reported as failed
  const scenarios = new Map((claims.scenarios ?? []).map((s) => [s.id, s]));
  const required = [...REQUIRED, ...(v3 ? REQUIRED_V3 : []), ...(context.group_id ? ["F7"] : [])];
  for (const id of required) {
    const s = scenarios.get(id);
    if (!s) fail(`scenario ${id} not reported`);
    else if (s.status === "skipped" && MAY_SKIP.has(id) && s.notes) {
      const external = v3 ? f1SkipEvidence(audited) : "";
      if (external === null) fail(`scenario ${id} skipped without an audited add_items_by_doi result that reports an external failure: ${s.notes}`);
      else ok(`scenario ${id} skipped: ${s.notes}${external ? ` (audit: ${external})` : ""}`);
    } else if (s.status !== "passed") fail(`scenario ${id} ${s.status ?? "without status"}${s.notes ? `: ${s.notes}` : ""}`);
  }
  for (const s of scenarios.values()) if (s.status === "failed" && !required.includes(s.id)) fail(`scenario ${s.id} failed${s.notes ? `: ${s.notes}` : ""}`);
  if (v3) {
    const t = targetedFindings(scenarios, context, loadScenarios());
    t.problems.forEach(fail);
    warnings.push(...t.warnings);
    checks.push(...t.checks);
  }

  if (calls && calls.length) {
    const edge = edgeCaseEvidence(calls, { anyCall: v3 });
    edge.problems.forEach(fail);
    if (!edge.problems.length) ok("F9/F10: edge cases verified on the audit");
    const x = exploratoryFindings(claims.exploratory, calls, edge.evidence, denials);
    x.problems.forEach(fail);
    warnings.push(...x.warnings);
    checks.push(...x.checks);
    exploratoryCalls.push(...x.calls);
  }

  // Created objects: they exist (unless claimed deleted), carry the run markers and match the claimed state
  const created = claims.created ?? [];
  const deleted = new Set((claims.deleted ?? []).map((d) => `${d.library_path}/${d.key}`));
  // keys the run created, still present or deleted by the agent (local runs move them to "deleted")
  const createdKeys = new Set([...created, ...(claims.deleted ?? [])].map((c) => `${c.library_path}/${c.key}`));
  const collectionKeys = new Set(created.filter((c) => c.kind === "collection").map((c) => c.key));
  const titles = new Map();
  const verifiedItems = new Set();
  const pending = [];
  // schema 3: each created entry names the call that created it; the title that call reported is the expected one
  const fromCalls = v3 ? createdCallFindings(created, audited, claims.library_path) : null;
  fromCalls?.problems.forEach(fail);
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
    if (fromCalls?.titles.has(c.key) && d.title !== undefined && d.title !== fromCalls.titles.get(c.key)) bad.push("title reported by its call_no");
    if (v3 && e.publicationTitle !== undefined && d.publicationTitle !== e.publicationTitle) bad.push("publicationTitle");
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

  if (v3 && context.cleanup !== "agent") {
    // every object the run created is declared (or was deleted): an undeclared one must at least carry the run markers
    const runCreated = createdByCalls(audited, claims.library_path);
    for (const u of undeclaredCreations(audited, claims, claims.library_path)) {
      if (!LIB.test(u.library_path ?? "")) continue;
      const r = await api(`${u.library_path}/${u.kind === "collection" ? "collections" : "items"}/${u.key}`);
      if (r.status === 404) continue;
      if (r.status !== 200) {
        fail(`${u.kind} ${u.key} (created by call_no ${u.call_no}, not in claims): HTTP ${r.status}`);
        continue;
      }
      const d = r.data.data;
      const isMarked =
        u.kind === "collection"
          ? String(d.name ?? "").startsWith(context.prefix)
          : marked({ d }) || (d.parentItem !== undefined && (createdKeys.has(`${u.library_path}/${d.parentItem}`) || runCreated.has(d.parentItem)));
      if (isMarked) warnings.push(`${u.kind} ${u.key} created by call_no ${u.call_no} (${u.tool}) but not declared in claims.json`);
      else fail(`${u.kind} ${u.key} created by call_no ${u.call_no} (${u.tool}), not declared in claims.json and without the run markers`);
    }
    warnings.push(...deletionWarnings(audited, claims.library_path));
  }
  if (v3) {
    const meta = metadataFindings(claims.metadata, audited, (p) => {
      const path = insideAgentOut(p);
      return path ? readFileSync(path, "utf8") : null;
    });
    meta.problems.forEach(fail);
    checks.push(...meta.checks);
  }

  // Deleted objects are really gone, and were created by this run (seen in a tool result of the run)
  const transcript = calls && calls.length ? attributableKeys(calls) : null;
  for (const dItem of claims.deleted ?? []) {
    if (!LIB.test(dItem.library_path ?? "") || !ZOTERO_KEY.test(String(dItem.key ?? ""))) {
      fail(`deleted entry with invalid library_path/key: ${JSON.stringify({ key: dItem.key, library_path: dItem.library_path })}`);
      continue;
    }
    if (transcript === null || (!transcript.deleted.has(dItem.key) && !transcript.created.has(dItem.key))) {
      fail(`deleted ${dItem.key} was neither created nor deleted by a Zotero tool call of this run`);
      continue;
    }
    const kind = dItem.kind === "collection" ? "collections" : "items";
    const r = await api(`${dItem.library_path}/${kind}/${dItem.key}`);
    const outcome = deletedClaimOutcome(dItem, r);
    if (outcome.ok) ok(outcome.message);
    else fail(outcome.message);
  }

  // Produced documents: valid structure/CSL/rendering, URIs pointing at created items
  const reports = [];
  for (const doc of claims.docx ?? []) {
    const path = insideAgentOut(doc.path);
    if (!path) {
      fail(`docx ${doc.path}: missing or outside agent-out/`);
      continue;
    }
    if (!STYLES.includes(doc.style)) {
      fail(`docx ${doc.path}: unknown style ${doc.style}`);
      continue;
    }
    if (!["inject_citations", "inject.js", "create_cited_document"].includes(doc.producer)) {
      fail(`docx ${doc.path}: unknown producer ${doc.producer}`);
      continue;
    }
    const sourcePath = insideAgentOut(doc.source);
    if (!sourcePath) {
      fail(`docx ${doc.path}: source ${doc.source} missing or outside agent-out/`);
      continue;
    }
    if (v3 && doc.document_prefs !== undefined && !STYLES.includes(doc.document_prefs)) {
      fail(`docx ${doc.path}: unknown document_prefs style ${doc.document_prefs}`);
      continue;
    }
    const isOdt = path.endsWith(".odt");
    const source = sourceFeatures(await documentXmlOf(sourcePath), sourcePath.endsWith(".odt"));
    // schema 3: every document with citations must carry the document preferences (of the source, if it had them)
    const prefsOptions = v3 ? { requireDocumentPrefs: source.zcites > 0, documentPrefsStyle: doc.document_prefs } : {};
    const validate = isOdt ? validateOdt : validateDocx;
    const report = await validate(readFileSync(path), { style: doc.style, libraryPath: doc.library_path, ...prefsOptions });
    const before = problems.length;
    for (const e of report.errors) fail(`docx ${doc.path}: ${e}`);
    // the numbering is the agent's choice; for author-date styles the visible text must match citeproc
    if (!NUMBERED.has(doc.style)) for (const m of report.mismatches) fail(`docx ${doc.path}: ${m}`);
    const countProblem = citationCountProblem(source, report.citations.length);
    if (countProblem) fail(`docx ${doc.path}: ${countProblem} in ${doc.source}`);
    for (const cite of report.citations) {
      for (const ci of cite.json.citationItems ?? []) {
        const m = /^http:\/\/zotero\.org\/((?:users|groups)\/\d+)\/items\/([A-Z0-9]{8})$/.exec(ci.uris?.[0] ?? "");
        if (!m) continue; // already reported by the validator
        const id = `${m[1]}/${m[2]}`;
        if (!createdKeys.has(id)) fail(`docx ${doc.path}: cites ${m[2]}, which is not among the created items`);
        else if (context.cleanup !== "agent" && titles.has(id) && titles.get(id) !== ci.itemData?.title) fail(`docx ${doc.path}: itemData title of ${m[2]} differs from Zotero`);
      }
    }
    reports.push({ doc, report, source, fingerprint: docxFingerprint(report, { prefs: v3 }), sourcePrefs: v3 ? await documentPrefsStyleOf(sourcePath) : null });
    if (problems.length === before) ok(`docx ${doc.path} (${doc.producer}, ${doc.style})`);
  }

  // inject_citations and inject.js on the same source, style and library must produce identical documents
  const groups = new Map();
  for (const r of reports) {
    if (!r.doc.compare_group) continue;
    groups.set(r.doc.compare_group, [...(groups.get(r.doc.compare_group) ?? []), r]);
  }
  const verifiedGroups = [];
  for (const [name, list] of groups) {
    const producers = new Set(list.map((r) => r.doc.producer));
    const same = (f) => new Set(list.map(f)).size === 1;
    if (producers.size < 2) fail(`compare_group ${name}: needs one inject_citations and one inject.js document`);
    else if (!same((r) => r.doc.style) || !same((r) => r.doc.library_path) || !same((r) => resolve(r.doc.source))) fail(`compare_group ${name}: documents differ in style, library or source`);
    else {
      const diff = list.map((r) => firstDifference(list[0].fingerprint, r.fingerprint)).find(Boolean);
      if (diff) fail(`compare_group ${name}: inject_citations and inject.js differ at ${diff}`);
      else {
        ok(`compare_group ${name}: identical fields, text and bibliography`);
        verifiedGroups.push({ name, ...list[0] });
      }
    }
  }
  // Required groups: the rich parity document in every style, the group library, the F9 edge documents
  for (const style of STYLES) {
    const g = verifiedGroups.find((v) => {
      const s = v.source;
      const cov = itemCoverage(v.report);
      return v.doc.style === style && v.doc.library_path === claims.library_path && s.multiKey && s.locatorPrefixSuffix && s.inline && s.split &&
        (!NUMBERED.has(style) || s.allNum) && cov.institutional && cov.noMetadata && cov.nonAscii;
    });
    if (!g) fail(`parity ${style}: no verified compare_group on the parity document (multi-key, locator+prefix+suffix, inline, split${NUMBERED.has(style) ? ", num on every tag" : ""}; institutional, undated/authorless and non-ASCII items)`);
  }
  if (context.group_id && scenarios.get("F7")?.status === "passed" && !verifiedGroups.some((v) => v.doc.library_path === `groups/${context.group_id}`)) {
    fail("parity group library: no verified compare_group on the test group");
  }
  if (!verifiedGroups.some((v) => v.source.spacedKeys && v.source.duplicateKey)) fail('F9: no verified compare_group on the edge document (keys "A, B", a duplicated key)');
  if (!verifiedGroups.some((v) => v.source.zcites === 0 && v.report.fields.length === 0)) fail("F9: no verified compare_group on a document without <zcite>");
  if (v3 && !verifiedGroups.some((v) => v.sourcePrefs && v.sourcePrefs !== STYLE_IDS[v.doc.style] && v.report.documentPrefs?.styleId === v.sourcePrefs)) {
    fail("F11: no verified compare_group on a document that already had Zotero document preferences of another style, kept by both producers");
  }

  if (RENDER) checkVisualReview(context, auditDir);

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

/** agent-out/visual-review.md against the index of the rendered pages (word-render). */
function checkVisualReview(context, auditDir) {
  // optional: the skill, agent config or hooks that ran predate the visual review (a pull request whose base branch
  // does not have them yet): whatever the agent wrote is reported as warnings only
  const fail = VISUAL === "optional" ? (m) => warnings.push(`${m} (visual review optional on this run)`) : problemsFail;
  const indexPath = join(RENDER, "index.json");
  if (!existsSync(indexPath)) return fail(`visual review: ${indexPath} missing (word-render output)`);
  const index = JSON.parse(readFileSync(indexPath, "utf8"));
  // Every page looked at: the Reads of agent-render/*.png that the audit hook recorded (image-reads.jsonl, outside
  // the agent's reach), not what the agent says
  const readsPath = join(auditDir, "image-reads.jsonl");
  if (!existsSync(readsPath)) {
    if (VISUAL === "optional") warnings.push("visual review: no audited page reads (the hooks that ran predate the image audit)");
    else fail(`visual review: ${readsPath} missing: no page read was audited`);
  } else {
    const read = new Set(parseTranscript(readFileSync(readsPath, "utf8")).filter((r) => r?.run_id === context.run_id && !r.is_error).map((r) => r.image));
    const unread = index.images.map((i) => i.image).filter((img) => !read.has(img));
    if (unread.length) fail(`visual review: ${unread.length} rendered page(s) never read: ${unread.join(", ")}`);
    else ok(`visual review: all ${index.images.length} rendered pages read (audit)`);
  }
  const path = join(DIR, VISUAL_REVIEW);
  if (!existsSync(path)) {
    if (VISUAL === "optional") return warnings.push(`visual review: ${VISUAL_REVIEW} not written (the skill that ran predates the visual review)`);
    return fail(`visual review: ${VISUAL_REVIEW} missing (${index.images.length} rendered pages to review)`);
  }
  const parsed = parseVisualReview(readFileSync(path, "utf8"));
  const invalid = visualReviewProblems(parsed, index);
  invalid.forEach((p) => fail(`visual review: ${p}`));
  const findings = visualReviewFindings(parsed);
  findings.problems.forEach(fail);
  warnings.push(...findings.warnings);
  if (!invalid.length) ok(`visual review: ${parsed.problems.length} content problems on ${index.images.length} pages, ${parsed.wordChecks.length} layout remarks`);
}

function finish(context) {
  const verdict = { run_id: context.run_id, verified: problems.length === 0, problems, warnings, checks: checks.length, exploratory_calls: exploratoryCalls };
  writeFileSync(join(DIR, "verdict.json"), scrub(JSON.stringify(verdict, null, 2)) + "\n");
  const lines = [
    `### Agent smoke: ${verdict.verified ? "claims verified" : "claims NOT verified"}`,
    "",
    `${checks.length} checks passed, ${problems.length} problems, ${warnings.length} warnings.`,
    ...problems.map((p) => `- ${scrub(p)}`),
    ...(warnings.length ? ["", "Warnings:", ...warnings.map((w) => `- ${scrub(w)}`)] : []),
  ];
  console.log(lines.join("\n"));
  return verdict.verified ? 0 : 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().then(
    (code) => process.exit(code),
    (e) => {
      console.error(`verify-claims: ${scrub(e instanceof Error ? e.message : String(e))}`);
      process.exit(2);
    }
  );
}
