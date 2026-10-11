import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
// @ts-expect-error plain .mjs hook library without type declarations
import { bashDecision, deleteDecision, createdKeys, responseText } from "../../.claude/agent-smoke/hooks/lib.mjs";
import { tempDir, TempDir } from "../helpers/fixtures.js";

/**
 * Hook dell'agente smoke (.claude/agent-smoke): allowlist dei comandi Bash, politica delle cancellazioni e log di
 * audit. Le decisioni si provano come funzioni e gli script come processi veri (stdin JSON → stdout/file), come li
 * esegue Claude Code. Ogni processo ha un timeout.
 */

const ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const HOOKS = join(ROOT, ".claude", "agent-smoke", "hooks");
const TIMEOUT_MS = 10_000;

function hook(script: string, input: unknown, projectDir: string): Promise<{ code: number; stdout: string }> {
  return new Promise((done) => {
    const child = execFile(
      process.execPath,
      [join(HOOKS, script)],
      { env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir }, timeout: TIMEOUT_MS, killSignal: "SIGKILL" },
      (err, stdout) => done({ code: err ? (typeof err.code === "number" ? err.code : -1) : 0, stdout })
    );
    child.stdin!.end(JSON.stringify(input));
  });
}

const MAKE = "node test/live/agent/make-docx.mjs";
const INJECT = "node test/live/agent/inject.mjs";
const SPEC = `'[["Single ", {"zcite": {"keys": "ABCD2345", "locator": "pp. 12-15", "prefix": "see "}}], [{"zcite": {"keys": "../items"}, "split": true}]]'`;

describe("hook Bash: solo i due wrapper nella forma esatta (AH-01)", () => {
  it.each([
    `${MAKE} agent-out/mzt-x-p-apa.docx ${SPEC}`,
    `${MAKE} agent-out/a.docx agent-out/b.docx agent-out/c.docx ${SPEC}`,
    `${MAKE} agent-out/nozcite.docx '[["No citations here."]]'`,
    `${INJECT} agent-out/a.docx agent-out/a_skill.docx agent-out/metadata.json users/16095680 apa`,
    `${INJECT} agent-out/a.docx agent-out/a_skill.docx agent-out/group-metadata.json groups/777 vancouver`,
    `${INJECT} agent-out/a.docx agent-out/a_skill.docx agent-out/metadata.json 424242`,
  ])("AH-01a ammesso: %s", (command) => {
    expect(bashDecision({ command, description: "x" })).toBeNull();
  });

  it.each([
    ["concatenazione ;", `${MAKE} agent-out/a.docx '[["x"]]'; ls`],
    ["&&", `${MAKE} agent-out/a.docx '[["x"]]' && ls`],
    ["||", `${INJECT} agent-out/a.docx agent-out/b.docx agent-out/m.json users/1 || ls`],
    ["pipe", `${INJECT} agent-out/a.docx agent-out/b.docx agent-out/m.json users/1 | cat`],
    ["redirezione >", `${INJECT} agent-out/a.docx agent-out/b.docx agent-out/m.json users/1 > /tmp/x`],
    ["redirezione <", `${MAKE} agent-out/a.docx < /etc/passwd`],
    ["2>&1", `${INJECT} agent-out/a.docx agent-out/b.docx agent-out/m.json users/1 2>&1`],
    ["$( ) nello spec", `${MAKE} agent-out/a.docx '[["$(whoami)"]]'`],
    ["backtick nello spec", `${MAKE} agent-out/a.docx '[["\`id\`"]]'`],
    ["& nello spec", `${MAKE} agent-out/a.docx '[["a & b"]]'`],
    ["backslash nello spec", `${MAKE} agent-out/a.docx '[["a\\\\"]]'`],
    ["a capo", `${MAKE} agent-out/a.docx '[["x"]]'\nls`],
    ["virgolette doppie al posto delle singole", `${MAKE} agent-out/a.docx "[[\\"x\\"]]"`],
    ["prefisso di variabile", `FOO=1 ${MAKE} agent-out/a.docx '[["x"]]'`],
    ["node -e", `node -e "require('fs')"`],
    ["node --eval", `node --eval 1`],
    ["node --require", `node --require ./x.js test/live/agent/make-docx.mjs agent-out/a.docx '[["x"]]'`],
    ["node --import", `node --import ./x.mjs test/live/agent/inject.mjs agent-out/a.docx agent-out/b.docx agent-out/m.json users/1`],
    ["percorso assoluto di node", `/usr/bin/node test/live/agent/make-docx.mjs agent-out/a.docx '[["x"]]'`],
    ["altro interprete", `bash -c 'ls'`],
    ["altro script", `node test/live/agent/prepare.mjs --mode local`],
    ["./ davanti allo script", `node ./test/live/agent/make-docx.mjs agent-out/a.docx '[["x"]]'`],
    ["doppio spazio", `node  test/live/agent/make-docx.mjs agent-out/a.docx '[["x"]]'`],
    ["uscita da agent-out", `${MAKE} agent-out/../x.docx '[["x"]]'`],
    ["percorso assoluto", `${INJECT} /tmp/a.docx agent-out/b.docx agent-out/m.json users/1`],
    ["metadata non json", `${INJECT} agent-out/a.docx agent-out/b.docx agent-out/m.txt users/1`],
    ["opzione in più", `${INJECT} agent-out/a.docx agent-out/b.docx agent-out/m.json users/1 apa --verbose`],
    ["stile non previsto", `${INJECT} agent-out/a.docx agent-out/b.docx agent-out/m.json users/1 mla`],
    ["libreria non valida", `${INJECT} agent-out/a.docx agent-out/b.docx agent-out/m.json orgs/1`],
    ["commento", `${INJECT} agent-out/a.docx agent-out/b.docx agent-out/m.json users/1 #x`],
    ["argomento dopo lo spec", `${MAKE} agent-out/a.docx '[["x"]]' agent-out/b.docx`],
    ["spec senza virgolette", `${MAKE} agent-out/a.docx [["x"]]`],
    ["comando vuoto", ``],
  ])("AH-01b negato: %s", (_label, command) => {
    expect(bashDecision({ command })).toBe("command not allowed");
  });

  it("AH-01c esecuzione in background e input senza comando → negati", () => {
    expect(bashDecision({ command: `${MAKE} agent-out/a.docx '[["x"]]'`, run_in_background: true })).toBe("background commands are not allowed");
    expect(bashDecision({})).toBe("no command");
    expect(bashDecision(null)).toBe("no command");
  });
});

describe("hook delete: solo chiavi create dalla run (AH-02)", () => {
  const ctx = { safe_mode: true, group_id: null };
  const created = new Set(["ITEM2222", "CLLC2222"]);
  it.each<[string, string, unknown, string | null]>([
    ["chiave creata", "mcp__zotero__delete_items", { item_keys: ["ITEM2222"] }, null],
    ["chiave finta inesistente (F10)", "mcp__zotero__delete_items", { item_keys: Array(51).fill("ZZZZZZZZ") }, null],
    ["array vuoto (lo rifiuta la validazione)", "mcp__zotero__delete_items", { item_keys: [] }, null],
    ["chiave non creata (sonda F0)", "mcp__zotero__delete_items", { item_keys: ["ITEM2222", "XXXXXXXX"] }, "XXXXXXXX was not created by this run"],
    ["chiave malformata", "mcp__zotero__delete_items", { item_keys: ["zzzzzzzz"] }, "malformed key: never pass one to a delete tool"],
    ["delete_collection in safe mode", "mcp__zotero__delete_collection", { collection_key: "CLLC2222" }, "delete_collection is never allowed in safe mode"],
    ["gruppo in safe mode", "mcp__zotero__delete_items", { item_keys: ["ITEM2222"], library_type: "group", library_id: "7" }, "deletions only in the test library"],
  ])("AH-02a %s", (_label, tool, input, expected) => {
    expect(deleteDecision(tool, input, ctx, created)).toBe(expected);
  });

  it("AH-02b fuori safe mode: delete_collection su collezione creata ammesso, gruppo solo quello di test, senza contesto tutto negato", () => {
    expect(deleteDecision("mcp__zotero__delete_collection", { collection_key: "CLLC2222" }, { safe_mode: false, group_id: "7" }, created)).toBeNull();
    expect(deleteDecision("mcp__zotero__delete_items", { item_keys: ["ITEM2222"], library_type: "group", library_id: "8" }, { safe_mode: false, group_id: "7" }, created)).toBe("deletions only in the test library");
    expect(deleteDecision("mcp__zotero__delete_items", { item_keys: ["ITEM2222"] }, null, created)).toMatch(/run context missing/);
  });

  it("AH-02c chiavi create lette dall'audit: solo risultati riusciti e campi strutturati", () => {
    const keys = createdKeys([
      { tool_name: "mcp__zotero__create_collection", is_error: false, text: '{"collection_key":"CLLC2222"}' },
      { tool_name: "mcp__zotero__add_items_by_doi", is_error: false, text: '{"success":[{"item_key":"DQIT2222"}],"pdf_results":[{"attachment_key":"PDFA2222"}]}' },
      { tool_name: "mcp__zotero__add_items", is_error: true, text: '{"success":[{"item_key":"ERRR2222"}]}' },
      { tool_name: "mcp__zotero__get_items_details", is_error: false, text: '{"EXST2222":{"title":"x"}}' },
      { tool_name: "Bash", is_error: false, text: '{"collection_key":"BASH2222"}' },
    ]);
    expect([...keys].sort()).toEqual(["CLLC2222", "DQIT2222", "PDFA2222"]);
  });

  it("AH-02d testo dei risultati: stringa, blocchi MCP, {content}, Bash {stdout, stderr}", () => {
    expect(responseText("x")).toBe("x");
    expect(responseText([{ type: "text", text: "a" }, { type: "image" }, { type: "text", text: "b" }])).toBe("ab");
    expect(responseText({ content: [{ type: "text", text: "c" }] })).toBe("c");
    expect(responseText({ stdout: "out", stderr: "err" })).toBe("out\nerr");
  });
});

describe("script degli hook come processi (AH-03)", () => {
  let dir: TempDir;
  beforeEach(async () => {
    dir = await tempDir();
    await mkdir(join(dir.path, "agent-audit"));
    await writeFile(join(dir.path, "agent-audit", "context.json"), JSON.stringify({ run_id: "r", safe_mode: true, group_id: null }));
  });
  afterEach(async () => {
    await dir?.cleanup();
  });
  const lines = async (file: string) =>
    (await readFile(join(dir.path, "agent-audit", file), "utf8").catch(() => ""))
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));

  it("AH-03a bash-guard: comando ammesso → nessun output; comando negato → decisione deny con motivo e riga in denials.jsonl", async () => {
    const allowed = await hook("bash-guard.mjs", { tool_name: "Bash", tool_input: { command: `${MAKE} agent-out/a.docx '[["x"]]'` } }, dir.path);
    expect(allowed).toEqual({ code: 0, stdout: "" });
    const denied = await hook("bash-guard.mjs", { tool_name: "Bash", tool_use_id: "u1", tool_input: { command: `${MAKE} agent-out/a.docx '[["x"]]' && ls` } }, dir.path);
    expect(denied.code).toBe(0);
    const out = JSON.parse(denied.stdout).hookSpecificOutput;
    expect(out).toMatchObject({ hookEventName: "PreToolUse", permissionDecision: "deny" });
    expect(out.permissionDecisionReason).toMatch(/Only these Bash commands are allowed/);
    expect(await lines("denials.jsonl")).toEqual([expect.objectContaining({ tool_name: "Bash", tool_use_id: "u1" })]);
  });

  it("AH-03b bash-guard: stdin non JSON → negato (fallisce chiuso)", async () => {
    const r = await new Promise<{ stdout: string }>((done) => {
      const child = execFile(process.execPath, [join(HOOKS, "bash-guard.mjs")], { env: { ...process.env, CLAUDE_PROJECT_DIR: dir.path }, timeout: TIMEOUT_MS }, (_e, stdout) => done({ stdout }));
      child.stdin!.end("not json");
    });
    expect(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision).toBe("deny");
  });

  it("AH-03c audit + delete-guard: la chiave creata (registrata dall'audit) si può cancellare, le altre no", async () => {
    await hook("audit.mjs", { hook_event_name: "PostToolUse", tool_name: "mcp__zotero__add_items", tool_use_id: "a1", tool_input: { items: [] }, tool_response: [{ type: "text", text: '{"success":[{"item_key":"ITEM2222"}]}' }] }, dir.path);
    await hook("audit.mjs", { hook_event_name: "PostToolUseFailure", tool_name: "mcp__zotero__get_collections", tool_use_id: "a2", tool_input: {}, error: "403: Forbidden" }, dir.path);
    await hook("audit.mjs", { hook_event_name: "PostToolUse", tool_name: "Read", tool_use_id: "a3", tool_input: {}, tool_response: "x" }, dir.path);
    expect(await lines("audit.jsonl")).toEqual([
      expect.objectContaining({ tool_use_id: "a1", tool_name: "mcp__zotero__add_items", is_error: false, text: '{"success":[{"item_key":"ITEM2222"}]}' }),
      expect.objectContaining({ tool_use_id: "a2", is_error: true, text: "403: Forbidden" }),
    ]);
    expect((await hook("delete-guard.mjs", { tool_name: "mcp__zotero__delete_items", tool_input: { item_keys: ["ITEM2222"] } }, dir.path)).stdout).toBe("");
    const denied = await hook("delete-guard.mjs", { tool_name: "mcp__zotero__delete_items", tool_input: { item_keys: ["XXXXXXXX"] } }, dir.path);
    expect(JSON.parse(denied.stdout).hookSpecificOutput.permissionDecisionReason).toMatch(/XXXXXXXX was not created by this run/);
  });

  it("AH-03d delete-guard senza agent-audit/context.json → negato", async () => {
    const empty = await tempDir();
    try {
      const r = await hook("delete-guard.mjs", { tool_name: "mcp__zotero__delete_items", tool_input: { item_keys: ["ZZZZZZZZ"] } }, empty.path);
      expect(JSON.parse(r.stdout).hookSpecificOutput.permissionDecisionReason).toMatch(/run context missing/);
    } finally {
      await empty.cleanup();
    }
  });

  it("AH-03e settings.json: i tre hook sugli eventi e matcher giusti, comandi via $CLAUDE_PROJECT_DIR", async () => {
    const settings = JSON.parse(await readFile(join(ROOT, ".claude", "agent-smoke", "settings.json"), "utf8"));
    const cmd = (event: string, matcher: string) => settings.hooks[event].find((h: { matcher: string }) => h.matcher === matcher)?.hooks[0];
    expect(cmd("PreToolUse", "Bash").command).toBe('node "$CLAUDE_PROJECT_DIR/.claude/agent-smoke/hooks/bash-guard.mjs"');
    expect(cmd("PreToolUse", "mcp__zotero__delete_items|mcp__zotero__delete_collection").command).toMatch(/delete-guard\.mjs"$/);
    for (const event of ["PostToolUse", "PostToolUseFailure"]) expect(cmd(event, "mcp__zotero__.*|Bash").command).toMatch(/audit\.mjs"$/);
    for (const event of Object.values(settings.hooks) as Array<Array<{ hooks: Array<{ timeout: number }> }>>) for (const h of event) expect(h.hooks[0].timeout).toBeGreaterThan(0);
  });
});
