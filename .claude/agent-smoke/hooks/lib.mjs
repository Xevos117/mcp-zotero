// Shared helpers of the agent smoke hooks (settings: .claude/agent-smoke/settings.json). Self-contained on
// purpose: on pull requests claude-code-action restores .claude/ from the base branch, so these files are the
// trusted base version while everything else in the checkout comes from the PR.
// Evidence lives in <project>/agent-audit/, outside agent-out/, where the agent cannot write (its Edit/Write
// rules and both allowed commands are confined to agent-out/).
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const ZOTERO_KEY = /^[23456789ABCDEFGHIJKLMNPQRSTUVWXYZ]{8}$/;
/** Valid-shape keys that exist in no library (F10, T-delete): deleting them is harmless. */
export const FAKE_KEYS = new Set(["ZZZZZZZZ", "YYYYYYYY"]);

export function projectDir(input) {
  return process.env.CLAUDE_PROJECT_DIR || input?.cwd || process.cwd();
}

export function auditDir(input) {
  return join(projectDir(input), "agent-audit");
}

export function readStdin() {
  try {
    return JSON.parse(readFileSync(0, "utf8") || "{}");
  } catch {
    return {};
  }
}

/** Run id from agent-audit/context.json (written by prepare.mjs), or null. */
export function runId(input) {
  try {
    return JSON.parse(readFileSync(join(auditDir(input), "context.json"), "utf8")).run_id ?? null;
  } catch {
    return null;
  }
}

/** Appends an entry stamped with the run id, so the verifier rejects evidence left over from another run. */
export function append(input, file, entry) {
  const dir = auditDir(input);
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, file), JSON.stringify({ ts: new Date().toISOString(), run_id: runId(input), ...entry }) + "\n");
}

/**
 * Next sequential number of an audited call (1, 2, ...), unique even when hooks of parallel tool calls run at
 * the same time: each number is claimed by creating agent-audit/call-no/<n> exclusively.
 */
export function nextCallNo(input) {
  return nextNo(input, "call-no");
}

/** Next number of a sequence kept as files in agent-audit/<sequence>/ (see nextCallNo). */
export function nextNo(input, sequence) {
  const dir = join(auditDir(input), sequence);
  mkdirSync(dir, { recursive: true });
  for (let n = readdirSync(dir).length + 1; ; n++) {
    try {
      writeFileSync(join(dir, String(n)), "", { flag: "wx" });
      return n;
    } catch (e) {
      if (e?.code !== "EEXIST") throw e;
    }
  }
}

export function readJsonl(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
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

/** PreToolUse denial with a reason the agent sees; also logged in agent-audit/denials.jsonl. */
export function deny(input, reason) {
  append(input, "denials.jsonl", { tool_name: input?.tool_name, tool_use_id: input?.tool_use_id, tool_input: input?.tool_input, reason });
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } }));
  process.exit(0);
}

/** Text of a tool response as the hooks receive it (string, MCP content blocks, {content}, Bash {stdout, stderr}). */
export function responseText(response) {
  if (response == null) return "";
  if (typeof response === "string") return response;
  if (Array.isArray(response)) return response.map((b) => (typeof b === "string" ? b : b?.type === "text" ? b.text : "")).join("");
  if (typeof response === "object") {
    if (Array.isArray(response.content)) return responseText(response.content);
    if ("stdout" in response || "stderr" in response) return [response.stdout, response.stderr].filter(Boolean).join("\n");
  }
  return JSON.stringify(response);
}

/** Keys created by successful Zotero calls recorded in the audit log (structured result fields only). */
export function createdKeys(entries) {
  const created = new Set();
  const add = (k) => typeof k === "string" && ZOTERO_KEY.test(k) && created.add(k);
  for (const e of entries) {
    if (e.is_error || !String(e.tool_name ?? "").startsWith("mcp__zotero__")) continue;
    let json;
    try {
      json = JSON.parse(e.text);
    } catch {
      continue;
    }
    if (!json || typeof json !== "object" || json.error) continue;
    switch (e.tool_name.slice("mcp__zotero__".length)) {
      case "create_collection":
        add(json.collection_key);
        break;
      case "add_items":
      case "add_items_by_doi":
        for (const x of json.success ?? []) add(x?.item_key);
        for (const x of json.pdf_results ?? []) add(x?.attachment_key);
        break;
      case "add_linked_url_attachment":
      case "import_pdf_to_zotero":
        add(json.item_key);
        break;
      case "find_and_attach_pdfs":
        for (const x of json.results ?? []) add(x?.attachment_key);
        break;
    }
  }
  return created;
}

// --- Visual review (audit.mjs records the page reads, visual-gate.mjs checks them) ---

/** File name of a rendered page the Read tool opened (agent-render/<name>.png of this project), or null. */
export function renderedPageRead(input) {
  if (input?.tool_name !== "Read") return null;
  const path = String(input?.tool_input?.file_path ?? "");
  const dir = join(projectDir(input), "agent-render") + "/";
  const rel = path.startsWith(dir) ? path.slice(dir.length) : path.startsWith("agent-render/") || path.startsWith("./agent-render/") ? path.replace(/^\.?\/?agent-render\//, "") : null;
  return rel && /^[A-Za-z0-9._-]+\.png$/.test(rel) ? rel : null;
}

/** Pages of agent-render/index.json (the word-render output), or null when there is none. */
export function renderedPages(input) {
  try {
    return JSON.parse(readFileSync(join(projectDir(input), "agent-render", "index.json"), "utf8")).images.map((i) => i.image);
  } catch {
    return null;
  }
}

/** Pages of index.json without an audited Read in this run (image-reads.jsonl). */
export function unreadPages(pages, reads, run) {
  const read = new Set(reads.filter((r) => r.run_id === run && !r.is_error).map((r) => r.image));
  return pages.filter((p) => !read.has(p));
}

// --- Bash allowlist (bash-guard.mjs) ---

const FILE = (ext) => `agent-out/[A-Za-z0-9._-]+\\.${ext}`;
// single-quoted JSON spec: no quote, backslash, newline or shell metacharacter inside either
const SPEC = "'[^'\\\\\\n\\r$`;&|<>]*'";
const STYLE = "(?:apa|ieee|vancouver|harvard|chicago)";
const LIBRARY = "(?:(?:users|groups)/[0-9]+|[0-9]+)";
const ALLOWED = [
  new RegExp(`^node test/live/agent/make-docx\\.mjs(?: ${FILE("docx")})+ ${SPEC}$`),
  new RegExp(`^node test/live/agent/inject\\.mjs ${FILE("docx")} ${FILE("docx")} ${FILE("json")} ${LIBRARY}(?: ${STYLE})?$`),
];
export const BASH_USAGE =
  "Only these Bash commands are allowed, exactly in this form, one per call: " +
  "node test/live/agent/make-docx.mjs agent-out/<name>.docx [agent-out/<name>.docx ...] '<json spec>' | " +
  "node test/live/agent/inject.mjs agent-out/<in>.docx agent-out/<out>.docx agent-out/<metadata>.json <users/ID|groups/ID> [style]. " +
  "No other programs, options, variables, quotes, chaining, pipes or redirections.";

export function bashDecision(toolInput) {
  const command = toolInput?.command;
  if (typeof command !== "string") return "no command";
  if (toolInput.run_in_background) return "background commands are not allowed";
  if (!ALLOWED.some((re) => re.test(command))) return "command not allowed";
  return null;
}

// --- Delete policy (delete-guard.mjs) ---

export function deleteDecision(toolName, toolInput, context, created) {
  if (!/^mcp__zotero__delete_(items|collection)$/.test(String(toolName))) return "not a delete tool";
  if (!context) return "run context missing (agent-audit/context.json): deletions are not allowed";
  const tool = String(toolName).replace(/^mcp__zotero__/, "");
  if (tool === "delete_collection" && context.safe_mode) return "delete_collection is never allowed in safe mode";
  if (toolInput?.library_type === "group" && (context.safe_mode || String(toolInput.library_id) !== String(context.group_id))) return "deletions only in the test library";
  const keys = tool === "delete_items" ? toolInput?.item_keys : [toolInput?.collection_key];
  if (!Array.isArray(keys)) return null; // not an array: the server rejects it
  for (const k of keys) {
    if (typeof k !== "string" || !ZOTERO_KEY.test(k)) return "malformed key: never pass one to a delete tool";
    if (!created.has(k) && !FAKE_KEYS.has(k)) return `${k} was not created by this run`;
  }
  return null;
}
