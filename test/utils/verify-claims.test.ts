import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  attributableKeys,
  robustnessProblems,
  writeSafetyProblems,
  edgeCaseProblems,
  edgeCaseEvidence,
  exploratoryFindings,
  sourceFeatures,
  docxFingerprint,
  firstDifference,
  itemCoverage,
  auditCalls,
  auditGaps,
  auditNumberingProblems,
  guardrailFindings,
  createdByCalls,
  createdCallFindings,
  undeclaredCreations,
  deletionWarnings,
  injectMetadataPath,
  metadataFindings,
  f1SkipEvidence,
  targetedFindings,
  // @ts-expect-error plain .mjs script without type declarations
} from "../../test/live/verify-claims.mjs";
import { startHarness } from "../helpers/mcp-harness.js";
import { ZBASE, zLibraryQuery, zSingle, article, USER_ID } from "../helpers/zotero-fake.js";
import { readDocumentXml, tempDir, TempDir } from "../helpers/fixtures.js";
import { validateDocx, CitationStyle } from "../helpers/docx-validate.js";
import { validateOdt } from "../helpers/citation-validate.js";

const ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const TIMEOUT_MS = 20_000;

type Call = [tool: string, input: unknown, result: unknown, isError?: boolean];

/** Trascrizione nel formato SDK che claude-code-action scrive nel file di esecuzione. */
function transcriptOf(calls: Call[]) {
  return calls.flatMap(([tool, input, result, isError], i) => {
    const name = tool === "Bash" ? "Bash" : `mcp__zotero__${tool}`;
    const text = typeof result === "string" ? result : JSON.stringify(result);
    return [
      { type: "assistant", message: { content: [{ type: "tool_use", id: `t${i}`, name, input }] } },
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: `t${i}`, is_error: isError ?? false, content: [{ type: "text", text }] }] } },
    ];
  });
}
const transcript = (calls: Array<[string, unknown, boolean?]>) => transcriptOf(calls.map(([tool, result, isError]) => [tool, {}, result, isError]));

function node(script: string, argv: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((done) => {
    execFile(process.execPath, [script, ...argv], { cwd: opts.cwd ?? ROOT, env: opts.env ?? process.env, timeout: TIMEOUT_MS, killSignal: "SIGKILL" }, (err, stdout, stderr) => {
      done({ code: err ? (typeof err.code === "number" ? err.code : -1) : 0, stdout, stderr });
    });
  });
}

describe("verify-claims: attribuzione delle chiavi dalla trascrizione", () => {
  it("VC-01 chiavi create e cancellate lette dai risultati dei tool, non da testo qualsiasi", () => {
    const { created, deleted } = attributableKeys(
      transcript([
        ["create_collection", { collection_key: "CLLC2222", name: "mzt-x" }],
        ["add_items", { success: [{ index: 0, item_key: "ITEM2222", title: "mzt-x a" }] }],
        ["add_items_by_doi", { success: [{ doi: "10.1/x", item_key: "DQIT2222" }], failed: [], pdf_results: [{ attachment_key: "PDFA2222", pdf_attached: true }] }],
        ["add_linked_url_attachment", { item_key: "LINK2222", link_mode: "linked_url" }],
        ["delete_items", { deleted_keys: ["ITEM2222"], deleted_count: 1, not_found: ["ABCDEFGH"] }],
        ["delete_collection", { deleted: true, collection_key: "CLLC2222", name: "mzt-x" }],
      ])
    );
    expect([...created].sort()).toEqual(["CLLC2222", "DQIT2222", "ITEM2222", "LINK2222", "PDFA2222"]);
    expect([...deleted].sort()).toEqual(["CLLC2222", "ITEM2222"]);
  });

  it("VC-02 chiave ripetuta solo in not_found, in un errore o in un tool non Zotero → non attribuita", () => {
    const messages = [
      ...transcript([
        ["delete_items", { deleted_keys: [], deleted_count: 0, not_found: ["ABCDEFGH"] }],
        ["get_items_details", { ABCDEFGH: { title: "x" } }],
        ["delete_items", { error: "No items found for the given keys", item_keys: ["ABCDEFGH"] }, true],
      ]),
      { type: "assistant", message: { content: [{ type: "tool_use", id: "w", name: "Write", input: { content: "ABCDEFGH" } }] } },
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "w", content: '{"deleted_keys":["ABCDEFGH"]}' }] } },
    ];
    const { created, deleted } = attributableKeys(messages);
    expect(created.has("ABCDEFGH")).toBe(false);
    expect(deleted.has("ABCDEFGH")).toBe(false);
  });
});

describe("verify-claims: robustezza di ogni risultato Zotero (VC-03)", () => {
  it("VC-03a trascrizione pulita (risultati JSON, errori con isError, errore di validazione) → nessun problema", () => {
    const messages = [
      { type: "system", subtype: "init", mcp_servers: [{ name: "zotero", status: "connected" }] },
      ...transcriptOf([
        ["search_library", { query: "mzt-x" }, [{ title: "undefined behaviour in C", key: "ITEM2222", authors: "Doe, J." }]],
        ["get_item_fulltext", { item_key: "ITEM2222" }, { item_key: "ITEM2222", text: "TypeError: x is NaN at line 3", characters: 30 }],
        ["get_item_fulltext", { item_key: "ZZZZZZZZ" }, { error: "Item not found", item_key: "ZZZZZZZZ" }, true],
        ["add_items", { items: [{}] }, "MCP error -32602: Input validation error: items[0].title: Invalid input: expected string, received undefined", true],
        ["create_collection", { name: "mzt-x undefined" }, { collection_key: "CLLC2222", name: "mzt-x undefined" }],
        ["Bash", { command: "node test/live/agent/inject.mjs agent-out/a.docx agent-out/b.docx agent-out/m.json users/1 apa" }, "Error: Invalid Zotero item key(s) in <zcite>: ../x (letters and digits only)", true],
      ]),
    ];
    expect(robustnessProblems(messages)).toEqual([]);
  });

  it.each<[string, Call, RegExp]>([
    ["connessione chiusa", ["get_collections", {}, "MCP error -32000: Connection closed", true], /connection closed, timeout or server crash/],
    ["timeout della richiesta", ["get_collections", {}, "MCP error -32001: Request timed out", true], /connection closed, timeout or server crash/],
    ["server non più disponibile", ["get_collections", {}, "Error: No such tool available: mcp__zotero__get_collections", true], /server crash/],
    ["errore senza isError", ["delete_items", { item_keys: ["ZZZZZZZZ"] }, { error: "No items found" }], /error result without isError/],
    ["risultato non JSON", ["get_collections", {}, "Collections: 3"], /not an MCP JSON result/],
    ["[object Object]", ["add_items", { items: [] }, { success: [], failed: [{ error: "[object Object]" }] }], /"\[object Object\]" leaked/],
    ["undefined", ["search_library", { query: "x" }, [{ title: "t", authors: "undefined undefined", key: "ITEM2222" }]], /"undefined" leaked/],
    ["NaN", ["get_item_fulltext", { item_key: "ITEM2222", max_characters: 5 }, { item_key: "ITEM2222", characters: "NaN", text: "" }], /"NaN" leaked/],
    ["stack trace", ["get_collections", {}, { error: "boom\n    at handle (/app/build/tools/x.js:10:5)" }, true], /stack trace/],
    ["TypeError", ["get_items_details", { item_keys: ["ITEM2222"] }, { error: "Cannot read properties of undefined (reading 'title')" }, true], /JavaScript error/],
    ["errore grezzo di JSON.parse in un elemento (X1)", ["add_items_by_doi", { dois: ["10.1/x"] }, { error: "All DOI resolutions failed", failed: [{ doi: "10.1/x", error: "Unexpected token '<', \"<!DOCTYPE \"... is not valid JSON" }] }, true], /JavaScript error/],
    ["fine inattesa del JSON", ["get_item_fulltext", { item_key: "ITEM2222" }, { error: "Unexpected end of JSON input" }, true], /JavaScript error/],
    ["crash di inject.js", ["Bash", { command: "node test/live/agent/inject.mjs agent-out/a.docx agent-out/b.docx agent-out/m.json users/1" }, "TypeError: Cannot read properties of null\n    at main (/r/inject.js:5:3)", true], /stack trace/],
  ])("VC-03b %s → problema", (_label, call, re) => {
    expect(robustnessProblems(transcriptOf([call])).join("\n")).toMatch(re);
  });

  it("VC-03c token inviato dall'agente nella stessa chiamata (es. titolo \"NaN\") → non è una perdita", () => {
    expect(robustnessProblems(transcriptOf([["add_items", { items: [{ itemType: "book", title: "mzt-x NaN" }] }, { success: [{ item_key: "ITEM2222", title: "mzt-x NaN" }], failed: [] }]]))).toEqual([]);
  });

  it("VC-03d server zotero non connesso all'avvio, chiamata senza risultato → problemi", () => {
    const messages = [
      { type: "system", subtype: "init", mcp_servers: [{ name: "zotero", status: "failed" }] },
      { type: "assistant", message: { content: [{ type: "tool_use", id: "x", name: "mcp__zotero__get_collections", input: {} }] } },
    ];
    expect(robustnessProblems(messages)).toEqual(["MCP server zotero failed at session start", "call #1 get_collections: no result (server hung or the run was cut)"]);
  });
});

describe("verify-claims: scritture solo su oggetti della run (VC-04)", () => {
  const ctx = { safe_mode: true, group_id: null };
  it("VC-04a chiavi create prima, chiavi finte e dry_run → nessun problema", () => {
    const messages = transcriptOf([
      ["create_collection", { name: "mzt-x" }, { collection_key: "CLLC2222" }],
      ["add_items", { items: [{}], collection_key: "CLLC2222" }, { success: [{ item_key: "ITEM2222" }] }],
      ["add_linked_url_attachment", { url: "https://e.org", parent_item: "ITEM2222", collections: ["CLLC2222"] }, { item_key: "LINK2222" }],
      ["find_and_attach_pdfs", { item_keys: ["EXST2222"], dry_run: true }, { processed: 1 }],
      ["delete_items", { item_keys: ["ITEM2222", "ZZZZZZZZ"] }, { deleted_keys: ["ITEM2222"], not_found: ["ZZZZZZZZ"] }],
    ]);
    expect(writeSafetyProblems(messages, ctx)).toEqual([]);
  });

  it.each<[string, Call, RegExp]>([
    ["delete_items su una voce preesistente", ["delete_items", { item_keys: ["EXST2222"] }, { deleted_keys: [] }], /item_keys EXST2222 was not created by this run/],
    ["allegato a una voce preesistente", ["add_linked_url_attachment", { url: "https://e.org", parent_item: "EXST2222" }, { item_key: "LINK2222" }], /parent_item EXST2222/],
    ["find_and_attach_pdfs reale su collezione preesistente", ["find_and_attach_pdfs", { collection_key: "EXST2222" }, { processed: 0 }], /collection_key EXST2222/],
    ["scrittura nel gruppo in safe mode", ["add_items", { items: [{}], library_type: "group", library_id: "7" }, { success: [] }], /group library written in safe mode/],
    ["chiave malformata a delete_items (anche per provare la validazione)", ["delete_items", { item_keys: ["zzzzzzzz"] }, "MCP error -32602: invalid", true], /malformed item_keys passed to a write tool/],
    ["delete_collection in safe mode", ["delete_collection", { collection_key: "ZZZZZZZZ" }, { error: "x" }, true], /delete_collection in safe mode/],
  ])("VC-04b %s → problema", (_label, call, re) => {
    expect(writeSafetyProblems(transcriptOf([call]), ctx).join("\n")).toMatch(re);
  });

  it("VC-04c fuori safe mode: solo il gruppo di test", () => {
    const call: Call = ["add_items", { items: [{}], library_type: "group", library_id: "8" }, { success: [] }];
    expect(writeSafetyProblems(transcriptOf([call]), { safe_mode: false, group_id: "7" })).toEqual(["call #1 add_items: group 8 is not the test group"]);
    expect(writeSafetyProblems(transcriptOf([[call[0], { ...(call[1] as object), library_id: "7" }, call[2]]]), { safe_mode: false, group_id: "7" })).toEqual([]);
  });

  it("VC-04d una scrittura negata dall'hook (guard probe su una chiave non creata) non è un problema: non è mai stata eseguita", () => {
    const denied: Call = ["update_item", { item_key: "EXST2222", version: 1 }, "Denied by the agent smoke harness: EXST2222 was not created by this run. Write only to what this run created.", true];
    expect(writeSafetyProblems(transcriptOf([denied]), ctx)).toEqual([]);
    // la stessa chiamata eseguita (non negata) sarebbe un problema di sicurezza
    const executed: Call = ["update_item", { item_key: "EXST2222", version: 1 }, { item_key: "EXST2222" }];
    expect(writeSafetyProblems(transcriptOf([executed]), ctx).join("\n")).toMatch(/item_key EXST2222 was not created by this run/);
  });
});

/** F9 + F10 completi, come li esegue l'agente seguendo la skill. */
function edgeCalls(): Call[] {
  const inj = "node test/live/agent/inject.mjs agent-out/e.docx agent-out/e_skill.docx agent-out/metadata.json users/1 apa";
  const fifty = Array(50).fill("ZZZZZZZZ");
  return [
    ["inject_citations", { file_path: "/w/agent-out/bad.docx" }, { error: "Invalid Zotero item key(s) in <zcite>: ../items (letters and digits only)" }, true],
    ["Bash", { command: inj }, "Exit code 1\nError: Invalid Zotero item key(s) in <zcite>: ../items (letters and digits only)", true],
    ["inject_citations", { file_path: "/w/agent-out/u.docx" }, "1 cited key(s) not found in the library: ZZZZZZZZ", true],
    ["Bash", { command: inj }, "Exit code 1\nError: 1 cited key(s) not found in the metadata: ZZZZZZZZ", true],
    ["inject_citations", { file_path: "/w/agent-out/n.docx" }, { output_path: "x", citations_found: 0, citations_injected: 0 }],
    ["Bash", { command: inj }, '{"output":"agent-out/n_skill.docx","found":0,"injected":0}'],
    ["delete_items", { item_keys: [] }, "MCP error -32602: Input validation error: too small", true],
    ["delete_items", { item_keys: fifty }, { error: "No items found for the given keys" }, true],
    ["delete_items", { item_keys: [...fifty, "ZZZZZZZZ"] }, "MCP error -32602: Input validation error: too big", true],
    ["add_items", { items: [] }, "MCP error -32602: Input validation error: too small", true],
    ["get_items_details", { item_keys: [] }, { message: "No items" }],
    ["get_items_details", { item_keys: ["   "] }, "MCP error -32602: Input validation error: invalid key", true],
    ["search_library", { query: "   ", limit: 1 }, [{ title: "a", key: "ITEM2222" }]],
    ["search_library", { query: "mzt-x", limit: 1 }, [{ title: "a", key: "ITEM2222" }]],
    ["search_library", { query: "mzt-x", limit: 100 }, [{ title: "a", key: "ITEM2222" }]],
    ["search_library", { query: "mzt-x", limit: 101 }, { message: "No results found" }],
  ];
}

describe("verify-claims: casi limite fissi F9/F10 dalla trascrizione (VC-05)", () => {
  it("VC-05a tutti i casi presenti con l'esito atteso → nessun problema", () => {
    expect(edgeCaseProblems(transcriptOf(edgeCalls()))).toEqual([]);
  });

  it.each<[string, (c: Call[]) => Call[], RegExp]>([
    ["inject.js accetta la chiave malformata", (c) => c.filter((_, i) => i !== 1), /no inject\.js run rejected a malformed/],
    ["inject_citations non fallisce sulla chiave sconosciuta", (c) => c.filter((_, i) => i !== 2), /no inject_citations call failed on the unknown key/],
    ["inject.js scrive comunque il documento con la chiave sconosciuta", (c) => c.map((x, i) => (i === 3 ? [x[0], x[1], 'Error: 1 cited key(s) not found in the metadata: ZZZZZZZZ\n{"found":1,"injected":1}'] : x)), /no inject\.js run failed on the unknown key/],
    ["documento senza zcite non provato con inject.js", (c) => c.filter((_, i) => i !== 5), /no inject\.js run on a document without <zcite>/],
    ["delete_items con 51 chiavi accettato", (c) => c.map((x, i) => (i === 8 ? [x[0], x[1], { deleted_keys: [], not_found: ["ZZZZZZZZ"] }] : x)), /51 fake keys \(max\+1\): accepted/],
    ["delete_items con 50 chiavi rifiutato dalla validazione", (c) => c.map((x, i) => (i === 7 ? [x[0], x[1], "MCP error -32602: too big", true] : x)), /50 fake keys \(max\): rejected by validation/],
    ["search_library limit 101 restituisce più di 100 voci", (c) => c.map((x, i) => (i === 15 ? [x[0], x[1], Array(101).fill({ key: "ITEM2222" })] : x)), /limit 101 \(max\+1\): 101 results/],
    ["caso F10 mancante", (c) => c.filter((x) => x[0] !== "add_items"), /F10: add_items with items \[\] not called/],
  ])("VC-05b %s → problema", (_label, mutate, re) => {
    expect(edgeCaseProblems(transcriptOf(mutate(edgeCalls()))).join("\n")).toMatch(re);
  });
});

describe("verify-claims: scenari esplorativi X1..X5 (VC-06)", () => {
  const messages = transcriptOf([
    ["add_items_by_doi", { dois: ["  "], tags: ["mzt-run:r"] }, { success: [], failed: [{ doi: "", error: "Invalid DOI" }] }],
    ["Bash", { command: "node test/live/agent/inject.mjs agent-out/a.docx agent-out/b.docx agent-out/m.json users/1", description: "run" }, "{}"],
  ]);
  const x = (over: Record<string, unknown> = {}) => ({
    id: "X1",
    rationale: "il diff cambia l'input di add_items_by_doi",
    calls: [{ tool: "add_items_by_doi", args: { tags: ["mzt-run:r"], dois: ["  "] } }],
    expected: "DOI vuoto rifiutato con messaggio leggibile",
    observed: "failed con Invalid DOI",
    verdict: "ok",
    ...over,
  });

  it("VC-06a scenario ok con chiamata presente (ordine delle chiavi indifferente) e comando Bash senza description → nessun problema", () => {
    const r = exploratoryFindings([x(), x({ id: "X2", calls: [{ tool: "Bash", args: { command: "node test/live/agent/inject.mjs agent-out/a.docx agent-out/b.docx agent-out/m.json users/1" } }] })], messages);
    expect(r).toMatchObject({ problems: [], warnings: [], checks: ["X1 ok", "X2 ok"] });
  });

  it("VC-06b assente → nessun controllo; unclear → avviso, non problema", () => {
    expect(exploratoryFindings(undefined, messages)).toEqual({ problems: [], warnings: [], checks: [], calls: [] });
    expect(exploratoryFindings([x({ verdict: "unclear" })], messages)).toMatchObject({ problems: [], warnings: [expect.stringMatching(/X1: unclear/)] });
  });

  it.each<[string, unknown, RegExp]>([
    ["verdetto bug", [x({ verdict: "bug" })], /X1: the agent found a bug/],
    ["più di 5 scenari", ["X1", "X2", "X3", "X4", "X5"].map((id) => x({ id })).concat([x({ id: "X5" })]), /6 scenarios \(max 5\)/],
    ["id non valido", [x({ id: "X6" })], /invalid or repeated id "X6"/],
    ["id ripetuto", [x(), x()], /invalid or repeated id "X1"/],
    ["chiamata mai fatta", [x({ calls: [{ tool: "delete_items", args: { item_keys: ["ZZZZZZZZ"] } }] })], /call 1 \(delete_items\) not found/],
    ["argomenti diversi", [x({ calls: [{ tool: "mcp__zotero__add_items_by_doi", args: { dois: [" "] } }] })], /call 1 \(add_items_by_doi\) not found/],
    ["rationale mancante", [x({ rationale: "" })], /X1: rationale missing/],
    ["verdetto non previsto", [x({ verdict: "pass" })], /verdict "pass" is not ok\|bug\|unclear/],
    ["non è un array", { X1: {} }, /exploratory is not an array/],
  ])("VC-06c %s → problema", (_label, list, re) => {
    expect(exploratoryFindings(list, messages).problems.join("\n")).toMatch(re);
  });
});

describe("verify-claims: chiamate esplorative per call_no dell'audit (VC-06d)", () => {
  const entry = (n: number, tool: string, input: unknown, text: string, isError = false) => ({ call_no: n, tool_use_id: `u${n}`, tool_name: tool, tool_input: input, is_error: isError, text });
  // argomento non ASCII: con call_no l'agente non deve ridigitarlo
  const calls = auditCalls([
    entry(1, "mcp__zotero__search_library", { query: "Müller–Ødegård “x”" }, "[]"),
    entry(2, "mcp__zotero__get_items_details", { item_keys: ["ZZZZZZZZ"] }, '{"error":"Input validation error"}', true),
    entry(3, "Bash", { command: "node test/live/agent/inject.mjs agent-out/a.docx agent-out/b.docx agent-out/m.json users/1", description: "x" }, "{}"),
  ]);
  const x = (callsClaimed: unknown[], over: Record<string, unknown> = {}) => ({ id: "X1", rationale: "r", calls: callsClaimed, expected: "e", observed: "o", verdict: "ok", ...over });

  it("VC-06d chiamate citate per call_no (strumento con o senza prefisso, Bash, esito) → nessun problema, argomenti non ridigitati", () => {
    const r = exploratoryFindings(
      [
        x([{ tool: "search_library", call_no: 1, is_error: false }, { tool: "mcp__zotero__get_items_details", call_no: 2, is_error: true }]),
        x([{ tool: "Bash", call_no: 3, is_error: false }], { id: "X2" }),
      ],
      calls
    );
    expect(r).toMatchObject({ problems: [], warnings: [], checks: ["X1 ok", "X2 ok"] });
  });

  it("VC-06i guard probe: una negazione dell'hook vale come prova (scenario senza chiamate o chiamata senza call_no); le F0 no, e senza negazioni è un problema", () => {
    const denial = { tool_name: "mcp__zotero__update_item", tool_input: { item_key: "XXXXXXXX" }, reason: "Denied by the agent smoke harness: XXXXXXXX was not created by this run" };
    // scenario senza chiamate citabili (tutto negato dall'hook): la negazione lo sostiene
    expect(exploratoryFindings([x([])], calls, new Set(), [denial])).toMatchObject({ problems: [], checks: ["X1: backed by a hook denial (guard probe, no audited call)", "X1 ok"] });
    // senza negazioni → "no calls"
    expect(exploratoryFindings([x([])], calls, new Set(), []).problems).toEqual(["X1: no calls"]);
    // una chiamata citata senza call_no che corrisponde a una negazione dello stesso tool: valida
    expect(exploratoryFindings([x([{ tool: "mcp__zotero__update_item" }])], calls, new Set(), [denial])).toMatchObject({
      problems: [],
      checks: ["X1: call 1 (update_item): denied by a hook (guard probe)", "X1 ok"],
    });
    // la stessa senza negazione: manca il call_no (l'audit numera ogni chiamata)
    expect(exploratoryFindings([x([{ tool: "mcp__zotero__update_item" }])], calls, new Set(), []).problems.join("\n")).toMatch(/call 1 \(update_item\): no call_no/);
    // una F0 probe (delete di XXXXXXXX) non è prova esplorativa → "no calls"
    const f0 = { tool_name: "mcp__zotero__delete_items", tool_input: { item_keys: ["XXXXXXXX"] }, reason: "Denied…" };
    expect(exploratoryFindings([x([])], calls, new Set(), [f0]).problems).toEqual(["X1: no calls"]);
  });

  it.each<[string, unknown, RegExp]>([
    ["call_no inesistente", { tool: "search_library", call_no: 9, is_error: false }, /X1: call 1 \(search_library\): call_no 9 not in the audit/],
    ["call_no non intero", { tool: "search_library", call_no: "1", is_error: false }, /call_no "1" not in the audit/],
    ["strumento diverso", { tool: "get_collections", call_no: 1, is_error: false }, /call_no 1 is a search_library call/],
    ["Bash dichiarato come tool Zotero", { tool: "inject_citations", call_no: 3, is_error: false }, /call_no 3 is a Bash call/],
    ["is_error mancante", { tool: "search_library", call_no: 1 }, /is_error \(true\|false\) missing/],
    ["esito diverso", { tool: "get_items_details", call_no: 2, is_error: false }, /call_no 2 claimed is_error false, the audit says true/],
    ["argomenti invece di call_no con audit numerato", { tool: "search_library", args: { query: "Müller–Ødegård “x”" } }, /no call_no \(the audit numbers every call/],
  ])("VC-06e %s → problema", (_label, call, re) => {
    expect(exploratoryFindings([x([call])], calls).problems.join("\n")).toMatch(re);
  });

  it("VC-06g ogni call_no citato una volta sola; mai la prova di un controllo fisso (F9/F10); input registrato dall'audit nel verdetto", () => {
    const twice = exploratoryFindings(
      [x([{ tool: "search_library", call_no: 1, is_error: false }]), x([{ tool: "search_library", call_no: 1, is_error: false }], { id: "X2" })],
      calls
    );
    expect(twice.problems).toEqual(["X2: call 1 (search_library): call_no 1 already claimed by X1 call 1"]);
    expect(twice.calls).toEqual([{ scenario: "X1", call_no: 1, tool: "search_library", input: '{"query":"Müller–Ødegård “x”"}' }]);
    const reserved = new Set([calls[1]]);
    expect(exploratoryFindings([x([{ tool: "get_items_details", call_no: 2, is_error: true }])], calls, reserved).problems).toEqual([
      "X1: call 1 (get_items_details): call_no 2 is the evidence of a fixed check (F9/F10), not an exploratory call",
    ]);
    // Bash: only the command, long inputs truncated
    const long = auditCalls([entry(1, "mcp__zotero__search_library", { query: "q".repeat(500) }, "[]"), entry(2, "Bash", { command: "node x", description: "d" }, "{}")]);
    const r = exploratoryFindings([x([{ tool: "search_library", call_no: 1, is_error: false }, { tool: "Bash", call_no: 2, is_error: false }])], long);
    expect(r.calls[0].input).toHaveLength(300);
    expect(r.calls[1]).toEqual({ scenario: "X1", call_no: 2, tool: "Bash", input: '{"command":"node x"}' });
  });

  it("VC-06h prova dei controlli fissi: le chiamate F9/F10 che li soddisfano", () => {
    const edge = auditCalls([
      entry(1, "mcp__zotero__search_library", { limit: 1 }, "[]"),
      entry(2, "mcp__zotero__search_library", { limit: 1 }, "[]"),
    ]);
    const { evidence } = edgeCaseEvidence(edge);
    expect([...evidence].map((c: { callNo: number }) => c.callNo)).toEqual([1]);
  });

  it("VC-06f audit senza numeri (hook del branch base precedenti): confronto per argomenti come prima", () => {
    const legacy = auditCalls([{ tool_use_id: "a", tool_name: "mcp__zotero__search_library", tool_input: { query: "q" }, is_error: false, text: "[]" }]);
    expect(exploratoryFindings([x([{ tool: "search_library", args: { query: "q" } }])], legacy).problems).toEqual([]);
    expect(exploratoryFindings([x([{ tool: "search_library", args: { query: "q2" } }])], legacy).problems).toEqual(["X1: call 1 (search_library) not found in the audit with the same arguments"]);
    expect(exploratoryFindings([x([{ tool: "search_library", call_no: 1, is_error: false }])], legacy).problems).toEqual(["X1: call 1 (search_library): call_no 1 not in the audit"]);
  });

  it.each<[string, Array<Record<string, unknown>>, string[]]>([
    ["senza numeri", [{ tool_name: "Bash" }, { tool_name: "Bash" }], []],
    ["1..3", [1, 3, 2].map((n) => ({ tool_name: "Bash", call_no: n })), []],
    ["ripetuto", [1, 2, 2].map((n) => ({ tool_name: "Bash", call_no: n })), ["audit: 1 repeated call_no"]],
    ["buco", [1, 2, 4].map((n) => ({ tool_name: "Bash", call_no: n })), ["audit: 1 call_no missing between 1 and 4 (lost entries)"]],
    ["voce senza numero in un audit numerato", [{ tool_name: "Bash", call_no: 1 }, { tool_name: "Bash" }], ["audit: 1 entry without a valid call_no"]],
  ])("VC-10d numerazione dell'audit: %s", (_label, entries, expected) => {
    expect(auditNumberingProblems(entries)).toEqual(expected);
  });
});

describe("verify-claims: documento di parità con i due produttori reali (VC-07, VC-08)", () => {
  let dir: TempDir;
  let out: string;
  const ITEMS = [
    article("RTCLQQRR", {
      title: "Über «Lernen» – 学习 ✓",
      date: "2021-05-02",
      volume: "7",
      pages: "1-9",
      creators: [
        { creatorType: "author", firstName: "Jürgen", lastName: "Müller-Ødegård" },
        { creatorType: "author", firstName: "Zoë", lastName: "Ångström" },
      ],
    }),
    { key: "BKQQRRTT", itemType: "book", title: "Consortium handbook", date: "2020", publisher: "Press", place: "Torino", creators: [{ creatorType: "author", name: "Test Consortium" }] },
    { key: "RPRTQQRR", itemType: "report", title: "Undated memo", date: "", creators: [] },
  ];
  const SPEC = (num: boolean) => {
    const n = (v: string) => (num ? { num: v } : {});
    return JSON.stringify([
      ["Single ", { zcite: { keys: "RTCLQQRR", ...n("1") } }, "."],
      ["Multi ", { zcite: { keys: "RTCLQQRR,BKQQRRTT", ...n("1,2") } }],
      ["Locator ", { zcite: { keys: "BKQQRRTT", locator: "pp. 12-15", prefix: "see ", suffix: ", emphasis added", ...n("2") } }],
      [{ zcite: { keys: "RPRTQQRR", ...n("3") }, before: "As the memo ", after: " shows, inline." }],
      ["Split ", { zcite: { keys: "RTCLQQRR,RPRTQQRR", ...n("1,3") }, split: true }, " end."],
    ]);
  };

  beforeAll(async () => {
    dir = await tempDir();
    out = join(dir.path, "agent-out");
    await mkdir(out);
    const make = join(ROOT, "test", "live", "agent", "make-docx.mjs");
    expect((await node(make, ["agent-out/p-apa.docx", "agent-out/p-harvard.docx", "agent-out/p-chicago.docx", SPEC(false)], { cwd: dir.path })).code).toBe(0);
    expect((await node(make, ["agent-out/p-ieee.docx", "agent-out/p-vancouver.docx", SPEC(true)], { cwd: dir.path })).code).toBe(0);
  });
  afterAll(async () => {
    await dir?.cleanup();
  });

  it("VC-07 make-docx: tag in linea e spezzato su tre run riconosciuti; casi F9 (spazi, chiave ripetuta)", async () => {
    const f = sourceFeatures(await readDocumentXml(await readFile(join(out, "p-ieee.docx"))));
    expect(f).toMatchObject({ zcites: 5, multiKey: true, locatorPrefixSuffix: true, inline: true, split: true, allNum: true, spacedKeys: false, duplicateKey: false });
    expect(sourceFeatures(await readDocumentXml(await readFile(join(out, "p-apa.docx")))).allNum).toBe(false);
    const make = join(ROOT, "test", "live", "agent", "make-docx.mjs");
    const edge = JSON.stringify([[{ zcite: { keys: "RTCLQQRR, BKQQRRTT" } }], [{ zcite: { keys: "RTCLQQRR,RTCLQQRR" } }], ["x"]]);
    expect((await node(make, ["agent-out/edge.docx", edge], { cwd: dir.path })).code).toBe(0);
    expect(sourceFeatures(await readDocumentXml(await readFile(join(out, "edge.docx"))))).toMatchObject({ zcites: 2, spacedKeys: true, duplicateKey: true, inline: false, split: false });
    expect((await node(make, ["../escape.docx", edge], { cwd: dir.path })).code).toBe(2);
    expect((await node(make, ["agent-out/bad.docx", '[[{"zcite": {"keys": "A\\"B"}}]]'], { cwd: dir.path })).code).toBe(2);
  });

  it.each<CitationStyle>(["apa", "harvard", "chicago", "ieee", "vancouver"])(
    "VC-08 %s: inject_citations e inject.js sullo stesso sorgente → stessa impronta (campi senza citationID, testo, bibliografia)",
    async (style) => {
      const h = await startHarness();
      try {
        h.net.on("GET", `${ZBASE}/items`, zLibraryQuery(ITEMS));
        for (const it of ITEMS) h.net.on("GET", `${ZBASE}/items/${it.key}`, zSingle(it));
        const details = await h.call("get_items_details", { item_keys: ITEMS.map((i) => i.key) });
        await writeFile(join(out, `meta-${style}.json`), JSON.stringify(details.json));
        const tool = await h.call("inject_citations", { file_path: join(out, `p-${style}.docx`), style });
        expect(tool.isError, tool.text).toBe(false);
        const skill = await node(
          join(ROOT, "test", "live", "agent", "inject.mjs"),
          [`agent-out/p-${style}.docx`, `agent-out/p-${style}_skill.docx`, `agent-out/meta-${style}.json`, `users/${USER_ID}`, style],
          { cwd: dir.path }
        );
        expect(skill.code, skill.stderr).toBe(0);
        expect(skill.stderr).not.toContain("WARNING");
        const a = await validateDocx(await readFile(tool.json.output_path), { style });
        const b = await validateDocx(await readFile(join(out, `p-${style}_skill.docx`)), { style });
        expect([...a.errors, ...b.errors]).toEqual([]);
        expect(a.citations).toHaveLength(5);
        expect(firstDifference(docxFingerprint(a), docxFingerprint(b))).toBeNull();
        expect(itemCoverage(a)).toEqual({ institutional: true, noMetadata: true, nonAscii: true });
        // the split and inline tags keep the surrounding text
        const fp = docxFingerprint(a);
        expect(fp.paragraphs[3]).toMatch(/^As the memo .+ shows, inline\.$/);
        expect(fp.paragraphs[4]).toMatch(/^Split .+ end\.$/);
        expect(fp.bibliography).toHaveLength(1);
      } finally {
        await h.close();
      }
    }
  );

  it("VC-08b l'impronta coglie ogni differenza fuori da citationID (locator, testo visibile, bibliografia)", async () => {
    const report = await validateDocx(await readFile(join(out, "p-apa_skill.docx")), { style: "apa" });
    const base = docxFingerprint(report);
    const other = JSON.parse(JSON.stringify(base));
    expect(firstDifference(base, JSON.parse(JSON.stringify(base)))).toBeNull();
    const withId = JSON.parse(JSON.stringify(report.citations));
    withId[0].json.citationID = "different";
    expect(firstDifference(base, docxFingerprint({ ...report, citations: withId }))).toBeNull();
    other.fields[2].citationItems[0].locator = "p. 1";
    expect(firstDifference(base, other)).toBe(".fields[2].citationItems[0].locator");
    const text = JSON.parse(JSON.stringify(base));
    text.visible[0] = "(X, 2021)";
    expect(firstDifference(base, text)).toBe(".visible[0]");
    const bib = JSON.parse(JSON.stringify(base));
    bib.bibliography = [];
    expect(firstDifference(base, bib)).toBe(".bibliography length 1 vs 0");
  });
  it("VC-08c schema 3: preferenze del documento in ogni documento e nell'impronta; caso \"preferenze mantenute\" (F11) con i due produttori", async () => {
    const make = join(ROOT, "test", "live", "agent", "make-docx.mjs");
    const kept = JSON.stringify({ prefs: "chicago", paragraphs: [["Kept ", { zcite: { keys: "RTCLQQRR" } }, "."]] });
    expect((await node(make, ["agent-out/kept.docx", kept], { cwd: dir.path })).code).toBe(0);
    expect((await node(make, ["agent-out/bad-prefs.docx", JSON.stringify({ prefs: "mla", paragraphs: [["x"]] })], { cwd: dir.path })).code).toBe(2);
    const h = await startHarness();
    try {
      h.net.on("GET", `${ZBASE}/items`, zLibraryQuery(ITEMS));
      for (const it of ITEMS) h.net.on("GET", `${ZBASE}/items/${it.key}`, zSingle(it));
      const tool = await h.call("inject_citations", { file_path: join(out, "kept.docx"), style: "apa" });
      expect(tool.isError, tool.text).toBe(false);
      expect(tool.json.warnings.join(" ")).toMatch(/already has Zotero document preferences/);
      const skill = await node(join(ROOT, "test", "live", "agent", "inject.mjs"), ["agent-out/kept.docx", "agent-out/kept_skill.docx", "agent-out/meta-apa.json", `users/${USER_ID}`, "apa"], { cwd: dir.path });
      expect(skill.code, skill.stderr).toBe(0);
      expect(skill.stderr).toMatch(/already has Zotero document preferences/);
      const opts = { style: "apa" as CitationStyle, requireDocumentPrefs: true, documentPrefsStyle: "chicago" as CitationStyle };
      const a = await validateDocx(await readFile(tool.json.output_path), opts);
      const b = await validateDocx(await readFile(join(out, "kept_skill.docx")), opts);
      expect([...a.errors, ...b.errors]).toEqual([]);
      expect(a.documentPrefs?.styleId).toBe("http://www.zotero.org/styles/chicago-author-date");
      expect(firstDifference(docxFingerprint(a, { prefs: true }), docxFingerprint(b, { prefs: true }))).toBeNull();
      // without documentPrefsStyle the kept preferences are another style: an error
      expect((await validateDocx(await readFile(tool.json.output_path), { style: "apa" })).errors.join("\n")).toMatch(/ZOTERO_PREF: stile .*chicago-author-date invece di .*apa/);
    } finally {
      await h.close();
    }
    // every parity output has the preferences of its style; schema 2 fingerprints leave them out
    const apa = await validateDocx(await readFile(join(out, "p-apa_skill.docx")), { style: "apa", requireDocumentPrefs: true });
    expect(apa.errors).toEqual([]);
    expect(docxFingerprint(apa, { prefs: true }).documentPrefs).toEqual({ styleId: "http://www.zotero.org/styles/apa", fieldType: "Field", chunks: 1 });
    expect(docxFingerprint(apa)).not.toHaveProperty("documentPrefs");
    const other = docxFingerprint(apa, { prefs: true });
    other.documentPrefs = null;
    expect(firstDifference(docxFingerprint(apa, { prefs: true }), other)).toBe(".documentPrefs");
  });

  it.each<CitationStyle>(["apa", "ieee"])(
    "VC-08d odt %s: docxFingerprint riconosce l'odt (sniff); inject_citations e inject.js danno la stessa impronta; le impronte docx restano invariate",
    async (style) => {
      const make = join(ROOT, "test", "live", "agent", "make-docx.mjs");
      expect((await node(make, ["--odt", `agent-out/o-${style}.odt`, SPEC(style === "ieee")], { cwd: dir.path })).code).toBe(0);
      const h = await startHarness();
      try {
        h.net.on("GET", `${ZBASE}/items`, zLibraryQuery(ITEMS));
        for (const it of ITEMS) h.net.on("GET", `${ZBASE}/items/${it.key}`, zSingle(it));
        const details = await h.call("get_items_details", { item_keys: ITEMS.map((i) => i.key) });
        await writeFile(join(out, `meta-odt-${style}.json`), JSON.stringify(details.json));
        const tool = await h.call("inject_citations", { file_path: join(out, `o-${style}.odt`), style });
        expect(tool.isError, tool.text).toBe(false);
        const skill = await node(
          join(ROOT, "test", "live", "agent", "inject.mjs"),
          [`agent-out/o-${style}.odt`, `agent-out/o-${style}_skill.odt`, `agent-out/meta-odt-${style}.json`, `users/${USER_ID}`, style],
          { cwd: dir.path }
        );
        expect(skill.code, skill.stderr).toBe(0);
        const a = await validateOdt(await readFile(tool.json.output_path), { style });
        const b = await validateOdt(await readFile(join(out, `o-${style}_skill.odt`)), { style });
        expect([...a.errors, ...b.errors]).toEqual([]);
        expect(a.citations).toHaveLength(5);
        // il fingerprint sniffa l'odt: niente campi w:fldChar, bibliografia dal nome della sezione ZOTERO_BIBL
        const fp = docxFingerprint(a, { prefs: true });
        expect(fp.bibliography).toEqual(["ZOTERO_BIBL {\"uncited\":[],\"omitted\":[],\"custom\":[]} CSL_BIBLIOGRAPHY"]);
        expect(fp.documentPrefs?.fieldType).toBe("ReferenceMark");
        expect(firstDifference(docxFingerprint(a, { prefs: true }), docxFingerprint(b, { prefs: true }))).toBeNull();
        // le impronte docx non cambiano: il ramo docx legge ancora i paragrafi dai w:t
        const docx = await validateDocx(await readFile(join(out, "p-apa_skill.docx")), { style: "apa" });
        expect(docxFingerprint(docx).paragraphs[0]).toMatch(/^Single /);
        expect(docxFingerprint(docx).bibliography[0]).toMatch(/^ADDIN ZOTERO_BIBL/);
      } finally {
        await h.close();
      }
    }
  );
});

describe("verify-claims: script completo senza rete (VC-09)", () => {
  const SCRIPT = join(ROOT, "test", "live", "verify-claims.mjs");
  let dir: TempDir;
  beforeAll(async () => {
    dir = await tempDir();
    await dir.file("context.json", JSON.stringify({ run_id: "r1", run_tag: "mzt-run:r1", prefix: "mzt-r1", cleanup: "agent", safe_mode: true, group_id: null }));
    await dir.file("claims.json", JSON.stringify({ schema_version: 2, run_id: "r1", library_path: "users/1", scenarios: [{ id: "P0", status: "passed" }], created: [], deleted: [], docx: [] }));
    await dir.file("execution.json", JSON.stringify(transcriptOf([["delete_items", { item_keys: ["EXST2222"] }, { deleted_keys: ["EXST2222"] }], ["get_collections", {}, []]])));
    // audit with only the delete (the get_collections call of the transcript is missing from it), plus an entry
    // left over from another run
    await dir.file(
      "audit.jsonl",
      [
        { run_id: "r1", tool_use_id: "t0", tool_name: "mcp__zotero__delete_items", tool_input: { item_keys: ["EXST2222"] }, is_error: false, text: '{"deleted_keys":["EXST2222"]}' },
        { run_id: "old", tool_use_id: "x9", tool_name: "mcp__zotero__get_user_id", tool_input: {}, is_error: false, text: "{}" },
      ].map((e) => JSON.stringify(e)).join("\n") + "\n"
    );
  });
  afterAll(async () => {
    await dir?.cleanup();
  });
  const env = { ...process.env, ZOTERO_TEST_API_KEY: "not-a-real-key", GITHUB_STEP_SUMMARY: "" };

  it("VC-09a senza --audit → exit 2", async () => {
    const r = await node(SCRIPT, [dir.path, "--transcript", join(dir.path, "execution.json")], { env });
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/--audit <audit\.jsonl> is required/);
  });

  it("VC-09b claims incompleti → exit 1, verdict.json con i problemi (scenari, sicurezza, sonde F0, buchi dell'audit, F9/F10, parità)", async () => {
    const r = await node(SCRIPT, [dir.path, "--audit", join(dir.path, "audit.jsonl"), "--transcript", join(dir.path, "execution.json")], { env });
    expect(r.code, r.stderr).toBe(1);
    const verdict = JSON.parse(await readFile(join(dir.path, "verdict.json"), "utf8"));
    expect(verdict.verified).toBe(false);
    expect(verdict.problems).toEqual(
      expect.arrayContaining([
        "scenario F1 not reported",
        "safety: call #1 delete_items: item_keys EXST2222 was not created by this run",
        "F10: add_items with items [] not called",
        "F0: the chained Bash probe was not denied by the Bash hook",
        "audit: 1 entry without this run's id (r1): evidence from another run",
        "evidence: call #2 get_collections of the transcript has no audit entry (hooks not active, or no result)",
        expect.stringMatching(/^parity apa: no verified compare_group/),
        expect.stringMatching(/^F9: no verified compare_group on the edge document/),
      ])
    );
    expect(r.stdout).not.toContain("not-a-real-key");
  });

  it("VC-09c --render: revisione o letture delle pagine mancanti → problema (avviso con --visual-review optional); pagine non lette, riferimenti sbagliati e bug visivi → problemi", async () => {
    const render = await tempDir();
    try {
      await render.file("index.json", JSON.stringify({ corpus: [{ id: "eve2020" }], knownIssues: [{ id: "H-W1", steps: ["apa"] }], images: [{ image: "apa-p1.png", document: "apa" }] }));
      const args = [dir.path, "--audit", join(dir.path, "audit.jsonl"), "--render", render.path];
      let r = await node(SCRIPT, args, { env });
      let verdict = JSON.parse(await readFile(join(dir.path, "verdict.json"), "utf8"));
      expect(verdict.problems).toContain("visual review: visual-review.md missing (1 rendered pages to review)");
      expect(verdict.problems).toContain(`visual review: ${join(dir.path, "image-reads.jsonl")} missing: no page read was audited`);
      r = await node(SCRIPT, [...args, "--visual-review", "optional"], { env });
      verdict = JSON.parse(await readFile(join(dir.path, "verdict.json"), "utf8"));
      expect(verdict.warnings).toContain("visual review: visual-review.md not written (the skill that ran predates the visual review)");
      expect(verdict.warnings).toContain("visual review: no audited page reads (the hooks that ran predate the image audit)");
      // a read of another run does not count
      await dir.file("image-reads.jsonl", JSON.stringify({ run_id: "old", image: "apa-p1.png" }) + "\n");
      r = await node(SCRIPT, args, { env });
      verdict = JSON.parse(await readFile(join(dir.path, "verdict.json"), "utf8"));
      expect(verdict.problems).toContain("visual review: 1 rendered page(s) never read: apa-p1.png");
      await dir.file("image-reads.jsonl", JSON.stringify({ run_id: "r1", read_no: 1, image: "apa-p1.png" }) + "\n");
      await dir.file(
        "visual-review.md",
        "# Revisione visiva\n## Problema 1: curatrice assente\n- Documento: apa\n- Pagina: apa-p1.png\n- Posizione: voce 4\n- Voce del corpus: eve2020\n- Reso: a\n- Atteso: b\n" +
          "## Problema 2: x\n- Documento: apa\n- Pagina: apa-p7.png\n- Posizione: voce 1\n- Voce del corpus: eve2020\n- Reso: a\n- Atteso: b\n- Noto: H-W1\n"
      );
      r = await node(SCRIPT, args, { env });
      expect(r.code).toBe(1);
      verdict = JSON.parse(await readFile(join(dir.path, "verdict.json"), "utf8"));
      expect(verdict.problems).toEqual(expect.arrayContaining(["visual review: problem 2: page apa-p7.png was not rendered", "visual 1 (apa-p1.png, voce 4): curatrice assente"]));
      expect(verdict.warnings).toContain("visual 2 (apa-p7.png, voce 1): x [known: H-W1]");
      expect(verdict.problems.filter((p: string) => p.includes("never read"))).toEqual([]);
      // optional (the base branch predates the visual review): the same findings only as warnings
      r = await node(SCRIPT, [...args, "--visual-review", "optional"], { env });
      verdict = JSON.parse(await readFile(join(dir.path, "verdict.json"), "utf8"));
      expect(verdict.problems.filter((p: string) => p.startsWith("visual"))).toEqual([]);
      expect(verdict.warnings).toContain("visual review: problem 2: page apa-p7.png was not rendered (visual review optional on this run)");
    } finally {
      await render.cleanup();
      await writeFile(join(dir.path, "visual-review.md"), "");
      await writeFile(join(dir.path, "image-reads.jsonl"), "");
    }
  });
});

describe("verify-claims: contesto della run fidato (VC-11)", () => {
  const SCRIPT = join(ROOT, "test", "live", "verify-claims.mjs");
  const env = { ...process.env, ZOTERO_TEST_API_KEY: "not-a-real-key", GITHUB_STEP_SUMMARY: "" };
  const ctx = { run_id: "r1", run_tag: "mzt-run:r1", prefix: "mzt-r1", cleanup: "verifier", safe_mode: false, group_id: null };
  const audit = JSON.stringify({ run_id: "r1", tool_use_id: "t0", tool_name: "mcp__zotero__get_user_id", tool_input: {}, is_error: false, text: "{}" }) + "\n";

  it.each<[string, Record<string, unknown> | null, boolean]>([
    ["copia identica", ctx, false],
    ["agent-out/context.json modificato dall'agente (cleanup)", { ...ctx, cleanup: "agent" }, true],
  ])("VC-11 %s", async (_label, agentCtx, differs) => {
    const dir = await tempDir();
    try {
      await mkdir(join(dir.path, "out"));
      await mkdir(join(dir.path, "audit"));
      await writeFile(join(dir.path, "out", "context.json"), JSON.stringify(agentCtx));
      await writeFile(join(dir.path, "audit", "audit-context.json"), JSON.stringify(ctx));
      await writeFile(join(dir.path, "audit", "audit.jsonl"), audit);
      const r = await node(SCRIPT, [join(dir.path, "out"), "--audit", join(dir.path, "audit", "audit.jsonl")], { env });
      expect(r.code, r.stderr).toBe(1);
      const verdict = JSON.parse(await readFile(join(dir.path, "out", "verdict.json"), "utf8"));
      const problem = verdict.problems.find((p: string) => p.includes("differs from the copy written before the agent started"));
      expect(Boolean(problem)).toBe(differs);
    } finally {
      await dir.cleanup();
    }
  });

  it("VC-11b nessuna copia del contesto accanto all'audit → problema", async () => {
    const dir = await tempDir();
    try {
      await mkdir(join(dir.path, "out"));
      await mkdir(join(dir.path, "audit"));
      await writeFile(join(dir.path, "out", "context.json"), JSON.stringify(ctx));
      await writeFile(join(dir.path, "audit", "audit.jsonl"), audit);
      await node(SCRIPT, [join(dir.path, "out"), "--audit", join(dir.path, "audit", "audit.jsonl")], { env });
      const verdict = JSON.parse(await readFile(join(dir.path, "out", "verdict.json"), "utf8"));
      expect(verdict.problems).toEqual(expect.arrayContaining([expect.stringMatching(/^trusted run context missing/)]));
    } finally {
      await dir.cleanup();
    }
  });
});

describe("verify-claims: contesto fidato con l'audit nella cartella dell'agente, come in CI (VC-12)", () => {
  const SCRIPT = join(ROOT, "test", "live", "verify-claims.mjs");
  const env = { ...process.env, ZOTERO_TEST_API_KEY: "not-a-real-key", GITHUB_STEP_SUMMARY: "" };
  const ctx = { run_id: "r1", run_tag: "mzt-run:r1", prefix: "mzt-r1", cleanup: "verifier", safe_mode: false, group_id: null };
  const audit = JSON.stringify({ run_id: "r1", tool_use_id: "t0", tool_name: "mcp__zotero__get_user_id", tool_input: {}, is_error: false, text: "{}" }) + "\n";

  it.each<[string, boolean, RegExp | null]>([
    ["senza audit-context.json: context.json dell'agente non vale come copia fidata", false, /^trusted run context missing/],
    ["con audit-context.json identico", true, null],
  ])("VC-12 %s", async (_label, withCopy, expected) => {
    const dir = await tempDir();
    try {
      await writeFile(join(dir.path, "context.json"), JSON.stringify(ctx));
      await writeFile(join(dir.path, "audit.jsonl"), audit);
      if (withCopy) await writeFile(join(dir.path, "audit-context.json"), JSON.stringify(ctx));
      await node(SCRIPT, [dir.path, "--audit", join(dir.path, "audit.jsonl")], { env });
      const problems: string[] = JSON.parse(await readFile(join(dir.path, "verdict.json"), "utf8")).problems;
      const contextProblems = problems.filter((p) => /trusted run context|differs from the copy/.test(p));
      if (expected) expect(contextProblems).toEqual([expect.stringMatching(expected)]);
      else expect(contextProblems).toEqual([]);
    } finally {
      await dir.cleanup();
    }
  });
});

describe("verify-claims: evidenza dagli hook (VC-10)", () => {
  const entry = (id: string, tool: string, input: unknown, text: string, isError = false) => ({ tool_use_id: id, tool_name: tool, tool_input: input, is_error: isError, text });

  it("VC-10a audit → stesse chiamate della trascrizione (chiavi create, robustezza, esplorativi)", () => {
    const calls = auditCalls([
      entry("a", "mcp__zotero__create_collection", { name: "mzt-x" }, '{"collection_key":"CLLC2222"}'),
      entry("b", "Bash", { command: "node test/live/agent/inject.mjs agent-out/a.docx agent-out/b.docx agent-out/m.json users/1", description: "x" }, "{}"),
      entry("c", "mcp__zotero__get_collections", {}, "MCP error -32000: Connection closed", true),
    ]);
    expect(attributableKeys(calls).created).toEqual(new Set(["CLLC2222"]));
    expect(robustnessProblems(calls)).toEqual(["call #3 get_collections: connection closed, timeout or server crash"]);
    const x = { id: "X1", rationale: "r", calls: [{ tool: "Bash", args: { command: "node test/live/agent/inject.mjs agent-out/a.docx agent-out/b.docx agent-out/m.json users/1" } }], expected: "e", observed: "o", verdict: "ok" };
    expect(exploratoryFindings([x], calls).problems).toEqual([]);
  });

  it("VC-10b buchi dell'audit: chiamata Zotero della trascrizione assente da audit e negazioni → problema; negata → nessuno", () => {
    const messages = transcriptOf([["get_collections", {}, []], ["delete_items", { item_keys: ["XXXXXXXX"] }, "PreToolUse hook error: Denied", true], ["get_user_id", {}, {}]]);
    expect(auditGaps(messages, [entry("t0", "mcp__zotero__get_collections", {}, "[]")], [{ tool_use_id: "t1", tool_name: "mcp__zotero__delete_items" }])).toEqual([
      "call #3 get_user_id of the transcript has no audit entry (hooks not active, or no result)",
    ]);
  });

  it("VC-10c sonde F0 negate dagli hook → nessun problema; altre negazioni → avvisi; sonde assenti → problemi", () => {
    const probes = [
      { tool_name: "Bash", tool_input: { command: "node test/live/agent/make-docx.mjs agent-out/mzt-x-probe.docx '[[\"probe\"]]' && ls" }, reason: "Denied by the agent smoke harness (command not allowed). Only…" },
      { tool_name: "mcp__zotero__delete_items", tool_input: { item_keys: ["XXXXXXXX"] }, reason: "Denied by the agent smoke harness: XXXXXXXX was not created by this run. Delete only…" },
    ];
    expect(guardrailFindings(probes)).toEqual({ problems: [], warnings: [] });
    expect(guardrailFindings([...probes, { tool_name: "Bash", tool_input: { command: "ls" }, reason: "Denied by the agent smoke harness (command not allowed). x" }]).warnings).toEqual([
      "denied by the hooks: Bash (Denied by the agent smoke harness (command not allowed))",
    ]);
    expect(guardrailFindings([]).problems).toEqual([
      "F0: the chained Bash probe was not denied by the Bash hook",
      "F0: the delete of XXXXXXXX was not denied by the delete hook",
    ]);
  });
});

describe("verify-claims: claims schema 3 (VC-13)", () => {
  const entry = (n: number, tool: string, input: unknown, result: unknown, isError = false) => ({
    run_id: "r1",
    call_no: n,
    tool_use_id: `t${n}`,
    tool_name: tool === "Bash" ? "Bash" : `mcp__zotero__${tool}`,
    tool_input: input,
    is_error: isError,
    text: typeof result === "string" ? result : JSON.stringify(result),
  });
  const calls = auditCalls([
    entry(1, "create_collection", { name: "mzt-r1 agent" }, { collection_key: "CLLC2222", name: "mzt-r1 agent" }),
    entry(2, "add_items", { items: [{ title: "mzt-r1 a" }, { title: "mzt-r1 to delete" }] }, { success: [{ index: 0, item_key: "ITEM2222", title: "mzt-r1 a" }, { index: 1, item_key: "DLTE2222", title: "mzt-r1 to delete" }] }),
    entry(3, "add_items_by_doi", { dois: ["10.1/x"], library_type: "group", library_id: "777" }, { success: [{ doi: "10.1/x", item_key: "GRPI2222", title: "From DOI" }], pdf_results: [{ attachment_key: "PDFA2222" }] }),
    entry(4, "delete_items", { item_keys: ["DLTE2222"] }, { deleted_keys: ["DLTE2222"], deleted_count: 1 }),
    entry(5, "delete_items", { item_keys: ["ITEM2222"] }, { deleted_keys: ["ITEM2222"], deleted_count: 1 }),
    entry(6, "get_items_details", { item_keys: ["ITEM2222"] }, { ITEM2222: { title: "mzt-r1 a" } }),
    entry(7, "Bash", { command: "node test/live/agent/inject.mjs agent-out/a.docx agent-out/a_skill.docx agent-out/metadata.json users/1 apa" }, '{"found":1}'),
    entry(8, "get_items_details", { item_keys: [] }, { error: "x" }, true),
  ]);

  it("VC-13a oggetti creati dall'audit con libreria, call_no e titolo riportato dal tool", () => {
    const m = createdByCalls(calls, "users/1");
    expect([...m.keys()]).toEqual(["CLLC2222", "ITEM2222", "DLTE2222", "GRPI2222", "PDFA2222"]);
    expect(m.get("CLLC2222")).toEqual({ kind: "collection", library_path: "users/1", call_no: 1, tool: "create_collection", name: "mzt-r1 agent" });
    expect(m.get("GRPI2222")).toMatchObject({ kind: "item", library_path: "groups/777", call_no: 3, name: "From DOI" });
    expect(m.get("PDFA2222")).toMatchObject({ kind: "attachment", call_no: 3, name: undefined });
  });

  it("VC-13b created[].call_no: deve essere la chiamata che ha creato la chiave; il titolo atteso è quello del risultato", () => {
    const res = createdCallFindings(
      [
        { kind: "item", key: "ITEM2222", call_no: 2, library_path: "users/1" },
        { kind: "collection", key: "CLLC2222", call_no: 2, library_path: "users/1" },
        { kind: "item", key: "GRPI2222", library_path: "groups/777" },
        { kind: "item", key: "NONE2222", call_no: 9, library_path: "users/1" },
        { kind: "item", key: "GRPI2222", call_no: 3, library_path: "users/1" },
      ],
      calls,
      "users/1"
    );
    expect(res.problems).toEqual([
      "collection CLLC2222: call_no 2 did not create it (call_no 1 did)",
      "item GRPI2222: call_no of the call that created it missing (claims schema 3)",
      "item NONE2222: call_no 9 did not create it (no audited call created it)",
      "item GRPI2222: created in groups/777 by call_no 3, claimed in users/1",
    ]);
    expect(res.titles).toEqual(new Map([["ITEM2222", "mzt-r1 a"]]));
  });

  it("VC-13c chiavi create non dichiarate (né cancellate); cancellazioni fuori da F8 → avvisi", () => {
    const undeclared = undeclaredCreations(calls, { created: [{ key: "CLLC2222" }], deleted: [] }, "users/1");
    expect(undeclared.map((u: { key: string }) => u.key)).toEqual(["GRPI2222", "PDFA2222"]);
    expect(deletionWarnings(calls, "users/1")).toEqual(['deletion outside F8: delete_items call_no 5 deleted ITEM2222, not created as "… to delete"']);
  });

  it("VC-13d metadata di inject.js: dichiarati con il call_no di un get_items_details riuscito e identici al suo risultato", () => {
    expect(injectMetadataPath("node test/live/agent/inject.mjs agent-out/a.docx agent-out/b.docx agent-out/m.json users/1")).toBe("agent-out/m.json");
    expect(injectMetadataPath("node test/live/agent/make-docx.mjs agent-out/a.docx '[]'")).toBeNull();
    const files: Record<string, string> = { "agent-out/metadata.json": JSON.stringify({ ITEM2222: { title: "mzt-r1 a" } }, null, 2), "agent-out/other.json": '{"ITEM2222":{"title":"typed again"}}' };
    const read = (p: string) => files[p] ?? null;
    expect(metadataFindings([{ path: "agent-out/metadata.json", call_no: 6 }], calls, read)).toEqual({ problems: [], checks: ["metadata agent-out/metadata.json = get_items_details call_no 6"] });
    expect(metadataFindings([], calls, read).problems).toEqual(["metadata agent-out/metadata.json: used by inject.js but not declared in claims.metadata with its call_no"]);
    expect(
      metadataFindings(
        [
          { path: "agent-out/metadata.json", call_no: 8 },
          { path: "agent-out/other.json", call_no: 6 },
          { path: "agent-out/gone.json", call_no: 6 },
        ],
        calls,
        read
      ).problems
    ).toEqual([
      "metadata agent-out/metadata.json: call_no 8 is not a successful get_items_details call of the audit",
      "metadata agent-out/other.json: differs from the result of get_items_details call_no 6 (write it verbatim)",
      "metadata agent-out/gone.json: missing or outside agent-out/",
    ]);
  });

  it("VC-13e F1 saltato: serve un risultato di add_items_by_doi con un guasto esterno", () => {
    expect(f1SkipEvidence(calls)).toBeNull();
    const outage = auditCalls([entry(1, "add_items_by_doi", { dois: ["10.1/x"] }, { error: "All DOIs failed", failed: [{ doi: "10.1/x", error: "DOI resolution failed for 10.1/x: 503" }] }, true)]);
    expect(f1SkipEvidence(outage)).toBe("DOI resolution failed for 10.1/x: 503");
    const notFound = auditCalls([entry(1, "add_items_by_doi", { dois: ["10.1/x"] }, { error: "DOI resolution failed for 10.1/x: 404" }, true)]);
    expect(f1SkipEvidence(notFound)).toBeNull();
  });

  it("VC-13h metadata usato solo da inject.js falliti (error path) non va dichiarato, che il file esista o no; un inject riuscito lo deve dichiarare", () => {
    const cmd = (m: string) => `node test/live/agent/inject.mjs agent-out/a.docx agent-out/b.docx ${m} users/1`;
    const failed = auditCalls([entry(3, "Bash", { command: cmd("agent-out/bad.json") }, "Error: Unexpected token in JSON", true)]);
    const check = "metadata agent-out/bad.json: not declared, used only by inject calls that failed (error-path test)";
    // file assente: tollerato
    expect(metadataFindings([], failed, () => null)).toEqual({ problems: [], checks: [check] });
    // file presente ma malformato (il nuovo caso #56): comunque tollerato, l'inject è fallito
    expect(metadataFindings([], failed, () => "{bad json")).toEqual({ problems: [], checks: [check] });
    // un inject riuscito deve sempre dichiarare il suo metadata
    const ok = auditCalls([entry(4, "Bash", { command: cmd("agent-out/s.json") }, '{"output":"agent-out/a_cited.docx","found":1,"injected":1}')]);
    expect(metadataFindings([], ok, () => null).problems).toEqual([
      "metadata agent-out/s.json: used by inject.js but not declared in claims.metadata with its call_no",
    ]);
    // e se lo stesso file è usato sia da un inject riuscito sia da uno fallito, va dichiarato
    const both = auditCalls([entry(5, "Bash", { command: cmd("agent-out/m.json") }, "Error", true), entry(6, "Bash", { command: cmd("agent-out/m.json") }, '{"found":1,"injected":1}')]);
    expect(metadataFindings([], both, () => "{}").problems).toEqual([
      "metadata agent-out/m.json: used by inject.js but not declared in claims.metadata with its call_no",
    ]);
  });

  it("VC-13f scenari T scelti dai file cambiati del contesto fidato: mancante o senza esito → problema, saltato con motivo → avviso", () => {
    const table = { rows: [{ id: "T-search", files: ["src/tools/search-library.ts"], scenario: "s" }, { id: "T-inject", files: ["src/citation-injector/**"], scenario: "i" }, { id: "T-link", files: ["src/tools/add-linked-url-attachment.ts"], scenario: "l" }] };
    const ctx = { changed_files: ["src/citation-injector/injector.ts", "src/tools/search-library.ts", "README.md"] };
    const res = targetedFindings(new Map([["T-inject", { id: "T-inject", status: "skipped", notes: "permessi" }]]), ctx, table);
    expect(res.required).toEqual(["T-search", "T-inject"]);
    expect(res.problems).toEqual(["scenario T-search (selected by the changed files) not reported"]);
    expect(res.warnings).toEqual(["scenario T-inject skipped: permessi"]);
    const ok = targetedFindings(new Map([["T-search", { status: "passed" }], ["T-inject", { status: "failed" }]]), ctx, table);
    expect(ok.problems).toEqual([]); // a failed scenario is reported with every failed scenario
    expect(targetedFindings(new Map(), {}, table).problems).toEqual([expect.stringMatching(/^context\.changed_files missing/)]);
  });

  it("VC-13g F10 con schema 3: la riga vale se una qualsiasi chiamata corrispondente ha l'esito atteso (prima contava solo la prima)", () => {
    const search = auditCalls([entry(1, "search_library", { query: "x", limit: 1 }, [{ key: "AAAA2222" }, { key: "BBBB2222" }]), entry(2, "search_library", { query: "x", limit: 1 }, [{ key: "AAAA2222" }])]);
    const row = (p: string) => p.startsWith("F10: search_library with limit 1:");
    expect(edgeCaseEvidence(search).problems.filter(row)).toEqual(["F10: search_library with limit 1: 2 results (expected at most 1)"]);
    const v3 = edgeCaseEvidence(search, { anyCall: true });
    expect(v3.problems.filter(row)).toEqual([]);
    expect([...v3.evidence].map((c: { callNo: number }) => c.callNo)).toContain(2);
  });
});

describe("verify-claims: claims schema 2 giudicati come prima (VC-14)", () => {
  const SCRIPT = join(ROOT, "test", "live", "verify-claims.mjs");
  const env = { ...process.env, ZOTERO_TEST_API_KEY: "not-a-real-key", GITHUB_STEP_SUMMARY: "" };
  const ctx = { run_id: "r1", run_tag: "mzt-run:r1", prefix: "mzt-r1", cleanup: "verifier", safe_mode: false, group_id: null, changed_files: ["src/tools/search-library.ts"], targeted: ["T-search"] };
  const e = (n: number, tool: string, input: unknown, result: unknown) => ({ run_id: "r1", call_no: n, tool_use_id: `t${n}`, tool_name: tool === "Bash" ? tool : `mcp__zotero__${tool}`, tool_input: input, is_error: false, text: typeof result === "string" ? result : JSON.stringify(result) });
  // every schema 3 requirement has a trigger here: a T row selected by the diff, F1 skipped without evidence, a
  // deletion outside F8, undeclared metadata, an F10 row met only by its second call, no F11
  const audit = [
    e(1, "add_items", { items: [{ itemType: "book", title: "mzt-r1 keep" }] }, { success: [{ index: 0, item_key: "ITEM2222", title: "mzt-r1 keep", item_type: "book" }] }),
    e(2, "delete_items", { item_keys: ["ITEM2222"] }, { deleted_keys: ["ITEM2222"], deleted_count: 1 }),
    e(3, "Bash", { command: "node test/live/agent/inject.mjs agent-out/a.docx agent-out/b.docx agent-out/metadata.json users/1 apa" }, '{"found":1,"injected":1}'),
    e(4, "search_library", { query: "mzt-r1", limit: 1 }, [{ key: "AAAA2222" }, { key: "BBBB2222" }]),
    e(5, "search_library", { query: "mzt-r1", limit: 1 }, [{ key: "AAAA2222" }]),
  ];
  // verdict of the verifier before schema 3 (main at 2.0.3) on this fixture with schema 2 claims
  const BEFORE = {
    problems: [
      "F0: the chained Bash probe was not denied by the Bash hook",
      "F0: the delete of XXXXXXXX was not denied by the delete hook",
      ...["F0", "F2", "F3", "F4", "F5", "F6", "F8", "F9", "F10"].map((id) => `scenario ${id} not reported`),
      'F9: no inject_citations call rejected a malformed <zcite> key ("Invalid Zotero item key(s) in <zcite>")',
      "F9: no inject.js run rejected a malformed <zcite> key with the same message",
      "F9: no inject_citations call failed on the unknown key",
      "F9: no inject.js run failed on the unknown key",
      "F9: no inject_citations call on a document without <zcite>",
      "F9: no inject.js run on a document without <zcite>",
      "F10: delete_items with item_keys [] not called",
      "F10: delete_items with 50 fake keys (max) not called",
      "F10: delete_items with 51 fake keys (max+1) not called",
      "F10: add_items with items [] not called",
      "F10: get_items_details with item_keys [] not called",
      "F10: get_items_details with a whitespace-only key not called",
      "F10: search_library with a whitespace-only query not called",
      "F10: search_library with limit 1: 2 results (expected at most 1)",
      "F10: search_library with limit 100 (max) not called",
      "F10: search_library with limit 101 (max+1) not called",
      ...["apa", "ieee", "vancouver", "harvard", "chicago"].map(
        (style) =>
          `parity ${style}: no verified compare_group on the parity document (multi-key, locator+prefix+suffix, inline, split${["ieee", "vancouver"].includes(style) ? ", num on every tag" : ""}; institutional, undated/authorless and non-ASCII items)`
      ),
      'F9: no verified compare_group on the edge document (keys "A, B", a duplicated key)',
      "F9: no verified compare_group on a document without <zcite>",
    ],
    warnings: [],
    checks: 4,
  };

  async function verdictFor(schema: number) {
    const dir = await tempDir();
    try {
      await mkdir(join(dir.path, "out"));
      await mkdir(join(dir.path, "audit"));
      await writeFile(join(dir.path, "out", "context.json"), JSON.stringify(ctx));
      await writeFile(join(dir.path, "audit", "audit-context.json"), JSON.stringify(ctx));
      await writeFile(join(dir.path, "audit", "audit.jsonl"), audit.map((x) => JSON.stringify(x)).join("\n") + "\n");
      const claims = { schema_version: schema, run_id: "r1", library_path: "users/1", scenarios: [{ id: "P0", status: "passed" }, { id: "F1", status: "skipped", notes: "doi.org non raggiungibile" }], created: [], deleted: [], docx: [] };
      await writeFile(join(dir.path, "out", "claims.json"), JSON.stringify(claims));
      const r = await node(SCRIPT, [join(dir.path, "out"), "--audit", join(dir.path, "audit", "audit.jsonl")], { env });
      expect(r.code, r.stderr).toBe(1);
      return JSON.parse(await readFile(join(dir.path, "out", "verdict.json"), "utf8"));
    } finally {
      await dir.cleanup();
    }
  }

  it("VC-14 schema 2: stesso verdetto del verificatore precedente, nessun requisito dello schema 3", async () => {
    const v = await verdictFor(2);
    expect({ problems: v.problems, warnings: v.warnings, checks: v.checks }).toEqual(BEFORE);
  });

  it("VC-14b schema 3 sullo stesso audit: i requisiti nuovi si attivano", async () => {
    const v = await verdictFor(3);
    const added = v.problems.filter((p: string) => !BEFORE.problems.includes(p));
    expect(added).toEqual([
      "scenario F1 skipped without an audited add_items_by_doi result that reports an external failure: doi.org non raggiungibile",
      "scenario F11 not reported",
      "scenario T-search (selected by the changed files) not reported",
      "metadata agent-out/metadata.json: used by inject.js but not declared in claims.metadata with its call_no",
      "F11: no verified compare_group on a document that already had Zotero document preferences of another style, kept by both producers",
    ]);
    expect(BEFORE.problems.filter((p) => !v.problems.includes(p))).toEqual(["F10: search_library with limit 1: 2 results (expected at most 1)"]);
    expect(v.warnings).toEqual(['deletion outside F8: delete_items call_no 2 deleted ITEM2222, not created as "… to delete"']);
  });
});
