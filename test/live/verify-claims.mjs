#!/usr/bin/env node
// Deterministic verdict for the agent smoke test (test-mcp-zotero skill). The agent's own report is
// informative only: this script checks what the agent claims in agent-out/claims.json against the
// Zotero Web API and the agent transcript, and validates every produced .docx with test/helpers/docx-validate.ts.
// Usage: ZOTERO_TEST_API_KEY=... node test/live/verify-claims.mjs [agent-out] --transcript <file>
// The transcript is the claude-code-action execution file (JSON array of SDK messages) or a Claude Code
// stream-json / session .jsonl. From it the script:
// - attributes every claimed deletion to a Zotero tool call of the run (created by it, or reported deleted);
// - scans every Zotero tool result for robustness failures (crash, error without isError, leaked
//   "[object Object]"/undefined/NaN, stack traces) and every write call for keys the run did not create;
// - checks the fixed edge cases (F9, F10) and that every claimed exploratory call (X1..X5) was really made.
// Exit 0 = verified, 1 = claims not verified, 2 = setup error. Writes <dir>/verdict.json and, in CI,
// a summary to $GITHUB_STEP_SUMMARY. No secret or library content is printed.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";
import { validateDocx } from "../helpers/docx-validate.ts";

const args = process.argv.slice(2);
const tIdx = args.indexOf("--transcript");
const TRANSCRIPT = tIdx >= 0 ? args[tIdx + 1] : undefined;
const DIR = resolve(args.find((a, i) => !a.startsWith("--") && (tIdx < 0 || i !== tIdx + 1)) ?? "agent-out");
const ZOTERO_KEY = /^[23456789ABCDEFGHIJKLMNPQRSTUVWXYZ]{8}$/;
const KEY = process.env.ZOTERO_TEST_API_KEY ?? "";
const REQUEST_TIMEOUT_MS = 30_000;
const SCHEMA_VERSION = 2;
const REQUIRED = ["P0", "F1", "F2", "F3", "F4", "F5", "F6", "F8", "F9", "F10"];
/** Fixed scenarios that depend on external services (doi.org, Unpaywall, publishers) may be skipped with a reason. */
const MAY_SKIP = new Set(["F1"]);
const STYLES = ["apa", "ieee", "vancouver", "harvard", "chicago"];
const NUMBERED = new Set(["ieee", "vancouver"]);
/** Valid-shape keys that exist in no library: the only foreign keys the agent may pass to a write tool or cite. */
export const FAKE_KEYS = new Set(["ZZZZZZZZ", "YYYYYYYY"]);
const MAX_EXPLORATORY = 5;
const LIB = /^(users|groups)\/\d+$/;
const ZOTERO_PREFIX = "mcp__zotero__";
const INJECT_CMD = /^node test\/live\/agent\/inject\.mjs\s/;
const INVALID_ZCITE = "Invalid Zotero item key(s) in <zcite>";

const problems = [];
const warnings = [];
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
  const calls = [];
  const byId = new Map();
  for (const m of Array.isArray(messages) ? messages : []) {
    for (const block of Array.isArray(m?.message?.content) ? m.message.content : []) {
      if (block?.type === "tool_use") {
        const name = String(block.name);
        const call = { id: block.id, name, tool: name.startsWith(ZOTERO_PREFIX) ? name.slice(ZOTERO_PREFIX.length) : null, input: block.input ?? {}, result: null };
        byId.set(block.id, call);
        calls.push(call);
      } else if (block?.type === "tool_result" && byId.has(block.tool_use_id)) {
        byId.get(block.tool_use_id).result = { isError: block.is_error === true, text: resultText(block.content) };
      }
    }
  }
  return calls;
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
const JS_ERROR = /\b(?:TypeError|ReferenceError|SyntaxError|RangeError):|Cannot read propert(?:y|ies) of|\bis not a function\b/;
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
};

/**
 * Every key a write call references must be well-formed and created earlier in the run (or be one of
 * FAKE_KEYS); group libraries are written only outside safe mode and only for context.group_id;
 * delete_collection is never called in safe mode.
 */
export function writeSafetyProblems(messages, context) {
  const out = [];
  const created = new Set();
  toolCalls(messages).forEach((call, i) => {
    const argNames = WRITE_KEY_ARGS[call.tool];
    if (argNames && !(call.tool === "find_and_attach_pdfs" && call.input?.dry_run === true)) {
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
  ["get_items_details with item_keys []", (c) => c.tool === "get_items_details" && keysOf(c, "item_keys")?.length === 0, () => null],
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

/** F9 checks: the same warning or rejection from inject_citations and from inject.js. */
export function edgeCaseProblems(messages) {
  const out = [];
  const calls = toolCalls(messages);
  const injects = calls.filter((c) => c.tool === "inject_citations" && c.result);
  const skill = calls.filter((c) => c.name === "Bash" && INJECT_CMD.test(String(c.input?.command ?? "")) && c.result);
  const has = (list, pred) => list.some(pred);
  const fakeIn = (text) => [...FAKE_KEYS].some((k) => text.includes(k));
  if (!has(injects, (c) => c.result.isError && c.result.text.includes(INVALID_ZCITE))) out.push(`F9: no inject_citations call rejected a malformed <zcite> key ("${INVALID_ZCITE}")`);
  if (!has(skill, (c) => c.result.text.includes(INVALID_ZCITE) && !/"injected"/.test(c.result.text))) out.push("F9: no inject.js run rejected a malformed <zcite> key with the same message");
  if (!has(injects, (c) => (successJson(c)?.warnings ?? []).some((w) => /not found in the library/.test(w) && fakeIn(w)))) out.push("F9: no inject_citations warning for the unknown key");
  if (!has(skill, (c) => /WARNING: \d+ cited key\(s\) not found in metadata\.json/.test(c.result.text) && fakeIn(c.result.text))) out.push("F9: no inject.js WARNING for the unknown key");
  if (!has(injects, (c) => successJson(c)?.citations_found === 0)) out.push("F9: no inject_citations call on a document without <zcite>");
  if (!has(skill, (c) => /"found":0\b/.test(c.result.text))) out.push("F9: no inject.js run on a document without <zcite>");
  for (const [desc, match, expect] of F10_ROWS) {
    const found = calls.filter((c) => match(c) && c.result);
    if (found.length === 0) out.push(`F10: ${desc} not called`);
    else {
      const problem = expect(found[0]);
      if (problem) out.push(`F10: ${desc}: ${problem}`);
    }
  }
  return out;
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

/**
 * At most 5 exploratory scenarios, each with a rationale, at least one call and a verdict; every claimed call
 * was really made (same tool, same arguments). "bug" fails the check, "unclear" is a warning.
 * @returns {{ problems: string[], warnings: string[], checks: string[] }}
 */
export function exploratoryFindings(list, messages) {
  const res = { problems: [], warnings: [], checks: [] };
  if (list === undefined) return res;
  if (!Array.isArray(list)) {
    res.problems.push("exploratory is not an array");
    return res;
  }
  if (list.length > MAX_EXPLORATORY) res.problems.push(`exploratory: ${list.length} scenarios (max ${MAX_EXPLORATORY})`);
  // Bash calls compare by command only (the harness adds a description)
  const argsOf = (name, input) => canonical(name === "Bash" ? { command: input?.command } : (input ?? {}));
  const made = toolCalls(messages).map((c) => ({ tool: c.tool, name: c.name, args: argsOf(c.name, c.input) }));
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
    if (!Array.isArray(x.calls) || x.calls.length === 0) res.problems.push(`${id}: no calls`);
    for (const [n, call] of (Array.isArray(x.calls) ? x.calls : []).entries()) {
      const tool = String(call?.tool ?? "");
      const short = tool.startsWith(ZOTERO_PREFIX) ? tool.slice(ZOTERO_PREFIX.length) : tool;
      const args = argsOf(tool, call?.args);
      const seen = made.some((m) => (m.tool === short || (m.tool === null && m.name === tool)) && m.args === args);
      if (!seen) res.problems.push(`${id}: call ${n + 1} (${short}) not found in the transcript with the same arguments`);
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

/** What the <zcite> tags of a source document exercise (tags are read across runs, as the normalizer does). */
export function sourceFeatures(documentXml) {
  const f = { zcites: 0, multiKey: false, locatorPrefixSuffix: false, inline: false, split: false, allNum: true, spacedKeys: false, duplicateKey: false, keys: [] };
  for (const p of documentXml.match(/<w:p[ >][\s\S]*?<\/w:p>/g) ?? []) {
    const segments = [...p.matchAll(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g)].map((m) => m[1]);
    const starts = [];
    let joined = "";
    for (const s of segments) {
      starts.push(joined.length);
      joined += s;
    }
    const segAt = (offset) => starts.findLastIndex((st) => st <= offset);
    for (const m of joined.matchAll(/&lt;zcite\s[\s\S]*?\/&gt;/g)) {
      f.zcites++;
      const first = segAt(m.index);
      const last = segAt(m.index + m[0].length - 1);
      if (first !== last) f.split = true;
      else if (segments[first].replace(m[0], "").trim()) f.inline = true;
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
 * Everything both producers must write identically, except the random citationID: the full field JSON of
 * every citation (citationItems with uris, itemData, locator, label, prefix, suffix; properties), the visible
 * text of every citation, the visible text of every paragraph, and the bibliography fields.
 */
export function docxFingerprint(report) {
  const fields = report.citations.map((c) => {
    const { citationID: _random, ...rest } = c.json;
    return rest;
  });
  const paragraphs = (report.documentXml.match(/<w:p[ >][\s\S]*?<\/w:p>/g) ?? []).map((p) =>
    decode([...p.matchAll(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g)].map((m) => m[1]).join(""))
  );
  return {
    fields,
    visible: report.citations.map((c) => c.visible),
    paragraphs,
    bibliography: report.fields.filter((f) => f.instr.trim().startsWith("ADDIN ZOTERO_BIBL")).map((f) => f.instr.trim()),
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
  return (await zip.file("word/document.xml")?.async("string")) ?? "";
}

function insideAgentOut(p) {
  const path = resolve(p ?? "");
  return path.startsWith(resolve("agent-out") + sep) && existsSync(path) ? path : null;
}

// ---------------------------------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------------------------------

async function main() {
  if (!KEY) {
    console.error("verify-claims: ZOTERO_TEST_API_KEY not set");
    return 2;
  }
  if (!TRANSCRIPT) {
    console.error("verify-claims: --transcript <file> is required (CI: the execution file; locally: the stream-json or session .jsonl)");
    return 2;
  }
  const context = readJson("context.json");
  const claims = readJson("claims.json");
  if (!context) {
    console.error(`verify-claims: ${join(DIR, "context.json")} missing (run test/live/agent/prepare.mjs first)`);
    return 2;
  }
  const messages = existsSync(TRANSCRIPT) ? parseTranscript(readFileSync(TRANSCRIPT, "utf8")) : null;
  if (messages === null) fail(`transcript ${TRANSCRIPT} missing: the run cannot be verified`);
  else {
    // Robustness and safety hold for the whole transcript, even when the agent did not finish
    const robustness = robustnessProblems(messages);
    robustness.forEach((p) => fail(`robustness: ${p}`));
    if (!robustness.length) ok(`robustness: ${toolCalls(messages).filter((c) => c.tool).length} Zotero tool results`);
    const safety = writeSafetyProblems(messages, context);
    safety.forEach((p) => fail(`safety: ${p}`));
    if (!safety.length) ok("safety: write calls only on objects of this run");
  }
  if (!claims) {
    fail("claims.json missing: the agent did not complete the skill");
    return finish(context);
  }
  if (claims.schema_version !== SCHEMA_VERSION) fail(`claims.schema_version ${claims.schema_version} != ${SCHEMA_VERSION}`);
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

  if (messages) {
    const edge = edgeCaseProblems(messages);
    edge.forEach(fail);
    if (!edge.length) ok("F9/F10: edge cases verified on the transcript");
    const x = exploratoryFindings(claims.exploratory, messages);
    x.problems.forEach(fail);
    warnings.push(...x.warnings);
    checks.push(...x.checks);
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

  // Deleted objects are really gone, and were created by this run (seen in a tool result of the run)
  const transcript = messages ? attributableKeys(messages) : null;
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
    if (r.status !== 404) fail(`${dItem.kind ?? "item"} ${dItem.key} claimed deleted but HTTP ${r.status}`);
    else ok(`deleted ${dItem.key}`);
  }

  // Produced documents: valid structure/CSL/rendering, URIs pointing at created items (or a fake key with
  // placeholder item data, F9)
  const reports = [];
  const fakeChecked = new Map();
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
    if (!["inject_citations", "inject.js"].includes(doc.producer)) {
      fail(`docx ${doc.path}: unknown producer ${doc.producer}`);
      continue;
    }
    const sourcePath = insideAgentOut(doc.source);
    if (!sourcePath) {
      fail(`docx ${doc.path}: source ${doc.source} missing or outside agent-out/`);
      continue;
    }
    const source = sourceFeatures(await documentXmlOf(sourcePath));
    const report = await validateDocx(readFileSync(path), { style: doc.style, libraryPath: doc.library_path });
    const before = problems.length;
    for (const e of report.errors) fail(`docx ${doc.path}: ${e}`);
    // the numbering is the agent's choice; for author-date styles the visible text must match citeproc
    if (!NUMBERED.has(doc.style)) for (const m of report.mismatches) fail(`docx ${doc.path}: ${m}`);
    if (report.citations.length !== source.zcites) fail(`docx ${doc.path}: ${report.citations.length} citations for ${source.zcites} <zcite> in ${doc.source}`);
    for (const cite of report.citations) {
      for (const ci of cite.json.citationItems ?? []) {
        const m = /^http:\/\/zotero\.org\/((?:users|groups)\/\d+)\/items\/([A-Z0-9]{8})$/.exec(ci.uris?.[0] ?? "");
        if (!m) continue; // already reported by the validator
        const id = `${m[1]}/${m[2]}`;
        if (FAKE_KEYS.has(m[2])) {
          if (canonical(ci.itemData) !== canonical({ type: "article-journal" })) fail(`docx ${doc.path}: unknown key ${m[2]} without placeholder item data`);
          if (!fakeChecked.has(id)) fakeChecked.set(id, (await api(`${m[1]}/items/${m[2]}`)).status);
          if (fakeChecked.get(id) !== 404) fail(`docx ${doc.path}: ${m[2]} is expected not to exist, HTTP ${fakeChecked.get(id)}`);
        } else if (!createdKeys.has(id)) fail(`docx ${doc.path}: cites ${m[2]}, which is not among the created items`);
        else if (context.cleanup !== "agent" && titles.has(id) && titles.get(id) !== ci.itemData?.title) fail(`docx ${doc.path}: itemData title of ${m[2]} differs from Zotero`);
      }
    }
    reports.push({ doc, report, source, fingerprint: docxFingerprint(report) });
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
  if (!verifiedGroups.some((v) => v.source.spacedKeys && v.source.duplicateKey && v.source.keys.some((k) => FAKE_KEYS.has(k)))) {
    fail('F9: no verified compare_group on the edge document (keys "A, B", a duplicated key, an unknown key)');
  }
  if (!verifiedGroups.some((v) => v.source.zcites === 0 && v.report.fields.length === 0)) fail("F9: no verified compare_group on a document without <zcite>");

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
  const verdict = { run_id: context.run_id, verified: problems.length === 0, problems, warnings, checks: checks.length };
  writeFileSync(join(DIR, "verdict.json"), scrub(JSON.stringify(verdict, null, 2)) + "\n");
  const lines = [
    `### Agent smoke: ${verdict.verified ? "claims verified" : "claims NOT verified"}`,
    "",
    `${checks.length} checks passed, ${problems.length} problems, ${warnings.length} warnings.`,
    ...problems.map((p) => `- ${scrub(p)}`),
    ...(warnings.length ? ["", "Warnings:", ...warnings.map((w) => `- ${scrub(w)}`)] : []),
  ];
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join("\n") + "\n");
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
