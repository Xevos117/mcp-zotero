import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
// @ts-expect-error plain .mjs hook library without type declarations
import { bashDecision, deleteDecision, writeDecision, createdKeys, responseText } from "../../.claude/agent-smoke/hooks/lib.mjs";
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
const PROMPTS = "node test/live/agent/prompts.mjs";
const SPEC = `'[["Single ", {"zcite": {"keys": "ABCD2345", "locator": "pp. 12-15", "prefix": "see "}}], [{"zcite": {"keys": "../items"}, "split": true}]]'`;

describe("hook Bash: solo i wrapper nella forma esatta (AH-01)", () => {
  it.each([
    `${MAKE} agent-out/mzt-x-p-apa.docx ${SPEC}`,
    `${MAKE} agent-out/a.docx agent-out/b.docx agent-out/c.docx ${SPEC}`,
    `${MAKE} agent-out/nozcite.docx '[["No citations here."]]'`,
    `${INJECT} agent-out/a.docx agent-out/a_skill.docx agent-out/metadata.json users/424242 apa`,
    `${INJECT} agent-out/a.docx agent-out/a_skill.docx agent-out/group-metadata.json groups/777 vancouver`,
    `${INJECT} agent-out/a.docx agent-out/a_skill.docx agent-out/metadata.json 424242`,
    // LibreOffice: make-docx con --odt, output .odt e inject con --format
    `${MAKE} --odt agent-out/a.odt ${SPEC}`,
    `${MAKE} agent-out/a.docx agent-out/b.odt ${SPEC}`,
    `${INJECT} agent-out/a.odt agent-out/a_cited.odt agent-out/metadata.json users/424242 apa --format odt`,
    `${INJECT} agent-out/a.docx agent-out/a_cited.docx agent-out/metadata.json users/424242 --format docx`,
    // prompts wrapper (read-only): list, and get with or without a single-quoted json-args
    `${PROMPTS} list`,
    `${PROMPTS} get note_from_item '{"item_key": "ABCD2345"}'`,
    `${PROMPTS} get import_references`,
    `${PROMPTS} get write_cited_document '{"topic": "x", "output_path": "agent-out/o.docx"}'`,
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
    ["prompt sconosciuto", `${PROMPTS} get bogus_prompt`],
    ["prompts list con argomento in più", `${PROMPTS} list extra`],
    ["prompts get senza nome", `${PROMPTS} get`],
    ["prompts args tra virgolette doppie", `${PROMPTS} get note_from_item "{}"`],
    ["prompts con concatenazione", `${PROMPTS} list; ls`],
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

  it("AH-02e create_note registra la chiave della nota tra quelle create (campo tollerante)", () => {
    expect([...createdKeys([{ tool_name: "mcp__zotero__create_note", is_error: false, text: '{"note_key":"NQTE2222"}' }])]).toEqual(["NQTE2222"]);
    expect([...createdKeys([{ tool_name: "mcp__zotero__create_note", is_error: false, text: '{"item_key":"NQTE3333"}' }])]).toEqual(["NQTE3333"]);
  });
});

describe("hook write: update_item/create_note solo su oggetti creati dalla run (AH-05)", () => {
  const created = new Set(["ITEM2222"]);
  it.each<[string, string, unknown, string | null]>([
    ["update_item su voce creata", "mcp__zotero__update_item", { item_key: "ITEM2222", version: 1, fields: {} }, null],
    ["create_note sotto una voce creata", "mcp__zotero__create_note", { parent_item_key: "ITEM2222", note: "x" }, null],
    ["update_item su voce non creata", "mcp__zotero__update_item", { item_key: "XXXXXXXX", version: 1 }, "XXXXXXXX was not created by this run"],
    ["create_note sotto una voce non creata", "mcp__zotero__create_note", { parent_item_key: "XXXXXXXX", note: "x" }, "XXXXXXXX was not created by this run"],
    ["chiave malformata", "mcp__zotero__update_item", { item_key: "zzzz" }, "malformed item_key: never pass one to a write tool"],
    ["chiave finta non ammessa per le scritture", "mcp__zotero__update_item", { item_key: "ZZZZZZZZ" }, "ZZZZZZZZ was not created by this run"],
  ])("AH-05a %s", (_label, tool, input, expected) => {
    expect(writeDecision(tool, input, { safe_mode: true, group_id: null }, created)).toBe(expected);
  });

  it("AH-05b gruppo: solo quello di test e fuori safe mode; senza contesto tutto negato", () => {
    expect(writeDecision("mcp__zotero__update_item", { item_key: "ITEM2222", library_type: "group", library_id: "7" }, { safe_mode: false, group_id: "7" }, created)).toBeNull();
    expect(writeDecision("mcp__zotero__update_item", { item_key: "ITEM2222", library_type: "group", library_id: "7" }, { safe_mode: true, group_id: "7" }, created)).toBe("writes only in the test library");
    expect(writeDecision("mcp__zotero__create_note", { parent_item_key: "ITEM2222", library_type: "group", library_id: "8" }, { safe_mode: false, group_id: "7" }, created)).toBe("writes only in the test library");
    expect(writeDecision("mcp__zotero__update_item", { item_key: "ITEM2222" }, null, created)).toMatch(/run context missing/);
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
    expect(await lines("denials.jsonl")).toEqual([expect.objectContaining({ run_id: "r", tool_name: "Bash", tool_use_id: "u1" })]);
  });

  it("AH-03b bash-guard: stdin non JSON → negato (fallisce chiuso)", async () => {
    const r = await new Promise<{ stdout: string }>((done) => {
      const child = execFile(process.execPath, [join(HOOKS, "bash-guard.mjs")], { env: { ...process.env, CLAUDE_PROJECT_DIR: dir.path }, timeout: TIMEOUT_MS }, (_e, stdout) => done({ stdout }));
      child.stdin!.end("not json");
    });
    expect(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision).toBe("deny");
  });

  it("AH-03c audit + delete-guard: la chiave creata (registrata dall'audit) si può cancellare, le altre no; call_no restituito all'agente", async () => {
    const first = await hook("audit.mjs", { hook_event_name: "PostToolUse", tool_name: "mcp__zotero__add_items", tool_use_id: "a1", tool_input: { items: [] }, tool_response: [{ type: "text", text: '{"success":[{"item_key":"ITEM2222"}]}' }] }, dir.path);
    const failed = await hook("audit.mjs", { hook_event_name: "PostToolUseFailure", tool_name: "mcp__zotero__get_collections", tool_use_id: "a2", tool_input: {}, error: "403: Forbidden" }, dir.path);
    const read = await hook("audit.mjs", { hook_event_name: "PostToolUse", tool_name: "Read", tool_use_id: "a3", tool_input: {}, tool_response: "x" }, dir.path);
    expect(await lines("audit.jsonl")).toEqual([
      expect.objectContaining({ run_id: "r", call_no: 1, tool_use_id: "a1", tool_name: "mcp__zotero__add_items", is_error: false, text: '{"success":[{"item_key":"ITEM2222"}]}' }),
      expect.objectContaining({ call_no: 2, tool_use_id: "a2", is_error: true, text: "403: Forbidden" }),
    ]);
    expect(JSON.parse(first.stdout)).toEqual({
      hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: 'audit call_no 1 (mcp__zotero__add_items): reference this call in claims.json as "call_no": 1' },
    });
    expect(JSON.parse(failed.stdout).hookSpecificOutput).toMatchObject({ hookEventName: "PostToolUseFailure", additionalContext: expect.stringMatching(/^audit call_no 2 /) });
    expect(read.stdout).toBe("");
    expect((await hook("delete-guard.mjs", { tool_name: "mcp__zotero__delete_items", tool_input: { item_keys: ["ITEM2222"] } }, dir.path)).stdout).toBe("");
    const denied = await hook("delete-guard.mjs", { tool_name: "mcp__zotero__delete_items", tool_input: { item_keys: ["XXXXXXXX"] } }, dir.path);
    expect(JSON.parse(denied.stdout).hookSpecificOutput.permissionDecisionReason).toMatch(/XXXXXXXX was not created by this run/);
  });

  it("AH-03h write-guard: update_item/create_note sulla voce creata ammessi, su altre negati", async () => {
    await hook("audit.mjs", { hook_event_name: "PostToolUse", tool_name: "mcp__zotero__add_items", tool_use_id: "w1", tool_input: { items: [] }, tool_response: [{ type: "text", text: '{"success":[{"item_key":"ITEM2222"}]}' }] }, dir.path);
    expect((await hook("write-guard.mjs", { tool_name: "mcp__zotero__update_item", tool_input: { item_key: "ITEM2222", version: 1, fields: {} } }, dir.path)).stdout).toBe("");
    expect((await hook("write-guard.mjs", { tool_name: "mcp__zotero__create_note", tool_input: { parent_item_key: "ITEM2222", note: "x" } }, dir.path)).stdout).toBe("");
    const denied = await hook("write-guard.mjs", { tool_name: "mcp__zotero__update_item", tool_input: { item_key: "XXXXXXXX", version: 1 } }, dir.path);
    expect(JSON.parse(denied.stdout).hookSpecificOutput.permissionDecisionReason).toMatch(/XXXXXXXX was not created by this run/);
  });

  it("AH-03f 12 hook audit in parallelo (chiamate parallele dell'agente) → call_no 1..12 senza ripetizioni, uno per voce", async () => {
    const outs = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        hook("audit.mjs", { hook_event_name: "PostToolUse", tool_name: "Bash", tool_use_id: `p${i}`, tool_input: { command: "x" }, tool_response: { stdout: "{}" } }, dir.path)
      )
    );
    const entries = await lines("audit.jsonl");
    expect(entries.map((e) => e.call_no).sort((a, b) => a - b)).toEqual(Array.from({ length: 12 }, (_, i) => i + 1));
    // the number told to the agent is the one in the audit entry of the same call
    for (const [i, out] of outs.entries()) {
      const told = Number(/call_no (\d+)/.exec(JSON.parse(out.stdout).hookSpecificOutput.additionalContext)![1]);
      expect(entries.find((e) => e.tool_use_id === `p${i}`).call_no).toBe(told);
    }
  });

  // Contract of Claude Code / Agent SDK hooks: exit 0 and one JSON object on stdout whose
  // hookSpecificOutput.additionalContext is shown to the model after the tool result (hookEventName = the event).
  // Checked for real once with claude -p and with the Agent SDK (settings file, Bash, Haiku): the model quoted the note.
  it.each(["PostToolUse", "PostToolUseFailure"])("AH-03g contratto dell'output di audit.mjs per %s: exit 0, un solo oggetto JSON, solo hookSpecificOutput con evento e additionalContext", async (event) => {
    const input = { hook_event_name: event, tool_name: "mcp__zotero__search_library", tool_use_id: "c1", tool_input: { query: "x" }, ...(event === "PostToolUse" ? { tool_response: [{ type: "text", text: "[]" }] } : { error: "boom" }) };
    const r = await hook("audit.mjs", input, dir.path);
    expect(r.code).toBe(0);
    expect(r.stdout.trim().split("\n")).toHaveLength(1);
    const out = JSON.parse(r.stdout);
    expect(Object.keys(out)).toEqual(["hookSpecificOutput"]);
    expect(Object.keys(out.hookSpecificOutput).sort()).toEqual(["additionalContext", "hookEventName"]);
    expect(out.hookSpecificOutput.hookEventName).toBe(event);
    expect(out.hookSpecificOutput.additionalContext).toBe('audit call_no 1 (mcp__zotero__search_library): reference this call in claims.json as "call_no": 1');
    expect(out.hookSpecificOutput.additionalContext.length).toBeLessThan(2000);
    // the number told is the one recorded
    expect((await lines("audit.jsonl"))[0].call_no).toBe(1);
  });

  it("AH-04a audit: le Read delle pagine renderizzate in image-reads.jsonl con read_no proprio, nessun call_no consumato; altre Read ignorate", async () => {
    const read = (file_path: string, id: string) => hook("audit.mjs", { hook_event_name: "PostToolUse", tool_name: "Read", tool_use_id: id, tool_input: { file_path } }, dir.path);
    for (const r of [await read(join(dir.path, "agent-render", "apa-p1.png"), "r1"), await read("agent-render/apa-p2.png", "r2"), await read(join(dir.path, "agent-out", "x.png"), "r3"), await read(join(dir.path, "agent-render", "index.json"), "r4"), await read(join(dir.path, "agent-render", "..", "agent-out", "a.png"), "r5")]) {
      expect(r.code).toBe(0);
      expect(r.stdout).toBe("");
    }
    expect((await lines("image-reads.jsonl")).map((e) => [e.read_no, e.image, e.run_id])).toEqual([[1, "apa-p1.png", "r"], [2, "apa-p2.png", "r"]]);
    await hook("audit.mjs", { hook_event_name: "PostToolUse", tool_name: "mcp__zotero__get_user_id", tool_use_id: "z", tool_input: {}, tool_response: "{}" }, dir.path);
    expect((await lines("audit.jsonl"))[0].call_no).toBe(1);
  });

  describe("AH-04b visual-gate (hook Stop)", () => {
    const index = (images: string[]) => mkdir(join(dir.path, "agent-render"), { recursive: true }).then(() => writeFile(join(dir.path, "agent-render", "index.json"), JSON.stringify({ images: images.map((image) => ({ image })) })));
    const stop = () => hook("visual-gate.mjs", { hook_event_name: "Stop", stop_hook_active: true }, dir.path);

    it("senza pagine renderizzate → nessun blocco", async () => {
      const r = await stop();
      expect(r.code).toBe(0);
      expect(r.stdout).toBe("");
    });

    it("pagine non lette o revisione mancante → decision block con le pagine mancanti, al massimo 2 volte; poi lascia fermare", async () => {
      await index(["apa-p1.png", "apa-p2.png"]);
      await hook("audit.mjs", { hook_event_name: "PostToolUse", tool_name: "Read", tool_use_id: "r1", tool_input: { file_path: join(dir.path, "agent-render", "apa-p1.png") } }, dir.path);
      const first = await stop();
      expect(first.code).toBe(0);
      const out = JSON.parse(first.stdout);
      expect(Object.keys(out).sort()).toEqual(["decision", "reason"]);
      expect(out.decision).toBe("block");
      expect(out.reason).toContain("apa-p2.png");
      expect(out.reason).not.toContain("apa-p1.png");
      expect(out.reason).toContain("write agent-out/visual-review.md");
      expect(JSON.parse((await stop()).stdout).decision).toBe("block");
      expect((await stop()).stdout).toBe("");
      expect(await lines("stop-blocks.jsonl")).toHaveLength(2);
    });

    it("tutte le pagine lette e revisione scritta → nessun blocco; letture di un'altra run non contano", async () => {
      await index(["apa-p1.png"]);
      await writeFile(join(dir.path, "agent-audit", "image-reads.jsonl"), JSON.stringify({ run_id: "old", image: "apa-p1.png" }) + "\n");
      await mkdir(join(dir.path, "agent-out"));
      await writeFile(join(dir.path, "agent-out", "visual-review.md"), "# Revisione visiva\nNessun problema di contenuto.\n");
      expect(JSON.parse((await stop()).stdout).reason).toContain("apa-p1.png");
      await hook("audit.mjs", { hook_event_name: "PostToolUse", tool_name: "Read", tool_use_id: "r1", tool_input: { file_path: "agent-render/apa-p1.png" } }, dir.path);
      expect((await stop()).stdout).toBe("");
    });
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

  it("AH-03e settings.json: gli hook sugli eventi e matcher giusti (Read per le pagine, Stop per la revisione visiva), comandi via $CLAUDE_PROJECT_DIR", async () => {
    const settings = JSON.parse(await readFile(join(ROOT, ".claude", "agent-smoke", "settings.json"), "utf8"));
    const cmd = (event: string, matcher: string) => settings.hooks[event].find((h: { matcher: string }) => h.matcher === matcher)?.hooks[0];
    expect(cmd("PreToolUse", "Bash").command).toBe('node "$CLAUDE_PROJECT_DIR/.claude/agent-smoke/hooks/bash-guard.mjs"');
    expect(cmd("PreToolUse", "mcp__zotero__delete_items|mcp__zotero__delete_collection").command).toMatch(/delete-guard\.mjs"$/);
    expect(cmd("PreToolUse", "mcp__zotero__update_item|mcp__zotero__create_note").command).toMatch(/write-guard\.mjs"$/);
    for (const event of ["PostToolUse", "PostToolUseFailure"]) expect(cmd(event, "mcp__zotero__.*|Bash|Read").command).toMatch(/audit\.mjs"$/);
    expect(settings.hooks.Stop[0].hooks[0].command).toBe('node "$CLAUDE_PROJECT_DIR/.claude/agent-smoke/hooks/visual-gate.mjs"');
    for (const event of Object.values(settings.hooks) as Array<Array<{ hooks: Array<{ timeout: number }> }>>) for (const h of event) expect(h.hooks[0].timeout).toBeGreaterThan(0);
  });
});
