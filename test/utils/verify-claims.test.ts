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
  exploratoryFindings,
  sourceFeatures,
  docxFingerprint,
  firstDifference,
  itemCoverage,
  auditCalls,
  auditGaps,
  guardrailFindings,
  // @ts-expect-error plain .mjs script without type declarations
} from "../../test/live/verify-claims.mjs";
import { startHarness } from "../helpers/mcp-harness.js";
import { ZBASE, zLibraryQuery, zSingle, article, USER_ID } from "../helpers/zotero-fake.js";
import { readDocumentXml, tempDir, TempDir } from "../helpers/fixtures.js";
import { validateDocx, CitationStyle } from "../helpers/docx-validate.js";

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
    expect(r).toEqual({ problems: [], warnings: [], checks: ["X1 ok", "X2 ok"] });
  });

  it("VC-06b assente → nessun controllo; unclear → avviso, non problema", () => {
    expect(exploratoryFindings(undefined, messages)).toEqual({ problems: [], warnings: [], checks: [] });
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
