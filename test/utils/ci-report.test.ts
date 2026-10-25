import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
// @ts-expect-error plain .mjs scripts without type declarations
import { groupName, maskOutput } from "../../test/live/mask-group-name.mjs";
// @ts-expect-error plain .mjs scripts without type declarations
import { buildSummary, inline, leakProblems, runStats, MARKER } from "../../test/live/agent/summary.mjs";
import { tempDir, TempDir } from "../helpers/fixtures.js";

/**
 * Testi pubblicati dalla CI (log, artifact, Job Summary, commento sulla PR): nome del gruppo di test mascherato,
 * scrubber e redattore che falliscono chiusi, riepilogo dell'agente smoke. Valori finti; ogni processo ha un timeout.
 */

const ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const TIMEOUT_MS = 10_000;
const GROUP = "Gruppo Prova Mzt";
const ENV = {
  ZOTERO_TEST_API_KEY: "FAKEKEY0123456789abcdef",
  ZOTERO_TEST_USER_ID: "7654321",
  ZOTERO_TEST_USERNAME: "fake-tester",
  ZOTERO_TEST_GROUP_ID: "8765432",
  ZOTERO_TEST_GROUP_NAME: GROUP,
};

function node(script: string, argv: string[], env: Record<string, string>, cwd = ROOT): Promise<{ code: number; stdout: string; stderr: string }> {
  // only PATH from the real environment: no real secret can leak into these runs
  return new Promise((done) => {
    execFile(process.execPath, [join(ROOT, script), ...argv], { cwd, env: { PATH: process.env.PATH ?? "", ...env }, timeout: TIMEOUT_MS, killSignal: "SIGKILL" }, (err, stdout, stderr) =>
      done({ code: err ? (typeof err.code === "number" ? err.code : -1) : 0, stdout, stderr })
    );
  });
}

const response = (status: number, body?: unknown) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

describe("nome del gruppo di test (test/live/mask-group-name.mjs, CR-01)", () => {
  it("CR-01a nome letto con la chiave di test, header API e timeout", async () => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const name = await groupName("8765432", "KEY", async (url: string, init: RequestInit) => {
      seen.push({ url, init });
      return response(200, { data: { name: ` ${GROUP} ` } });
    });
    expect(name).toBe(GROUP);
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe("https://api.zotero.org/groups/8765432");
    expect(seen[0].init.headers).toMatchObject({ "Zotero-API-Key": "KEY", "Zotero-API-Version": "3" });
    expect(seen[0].init.signal).toBeInstanceOf(AbortSignal);
  });

  it("CR-01b 503 poi 200 → riprova; 404 → errore subito; rete giù 3 volte → errore; mai il nome nell'errore", async () => {
    let calls = 0;
    expect(await groupName("1", "K", async () => (++calls === 1 ? response(503) : response(200, { data: { name: GROUP } })), 1)).toBe(GROUP);
    expect(calls).toBe(2);
    calls = 0;
    await expect(groupName("1", "K", async () => (calls++, response(404)), 1)).rejects.toThrow("cannot read the test group (HTTP 404)");
    expect(calls).toBe(1);
    await expect(groupName("1", "K", async () => { throw new TypeError("fetch failed"); }, 1)).rejects.toThrow("cannot read the test group (TypeError)");
    await expect(groupName("1", "K", async () => response(200, { data: {} }), 1)).rejects.toThrow("no name in the API response");
  });

  it("CR-01c ::add-mask:: su stdout e voce multilinea per $GITHUB_ENV; a capo nel nome rifiutato", () => {
    expect(maskOutput(GROUP, "DELIM")).toEqual({ stdout: `::add-mask::${GROUP}\n`, env: `ZOTERO_TEST_GROUP_NAME<<DELIM\n${GROUP}\nDELIM\n` });
    expect(maskOutput(GROUP).env).toMatch(/^ZOTERO_TEST_GROUP_NAME<<MZT_[0-9a-f]{16}\n/);
    expect(() => maskOutput("a\nb")).toThrow(/line break/);
  });

  it("CR-01d come processo: senza gruppo → niente da fare; gruppo senza chiave o non numerico → exit 1", async () => {
    expect(await node("test/live/mask-group-name.mjs", [], {})).toMatchObject({ code: 0, stdout: "mask-group-name: no test group configured\n" });
    expect((await node("test/live/mask-group-name.mjs", [], { ZOTERO_TEST_GROUP_ID: "1" })).stderr).toMatch(/ZOTERO_TEST_API_KEY missing/);
    expect((await node("test/live/mask-group-name.mjs", [], { ZOTERO_TEST_GROUP_ID: "x", ZOTERO_TEST_API_KEY: "K" })).code).toBe(1);
  });
});

describe("scrubber e redattore con il nome del gruppo (CR-02)", () => {
  let dir: TempDir;
  beforeEach(async () => {
    dir = await tempDir();
    await mkdir(join(dir.path, "in"));
    await writeFile(
      join(dir.path, "in", "report.json"),
      JSON.stringify({ msg: `library ${GROUP}, uri http://zotero.org/groups/8765432/items/ABCD2345, user users/7654321 fake-tester` })
    );
  });
  afterEach(async () => {
    await dir?.cleanup();
  });

  it("CR-02a scrub-report: nome del gruppo, id e username mascherati", async () => {
    const r = await node("test/live/scrub-report.mjs", ["out", "in"], ENV, dir.path);
    expect(r.code).toBe(0);
    const text = await readFile(join(dir.path, "out", "in", "report.json"), "utf8");
    expect(text).not.toContain(GROUP);
    expect(text).not.toMatch(/8765432|7654321|fake-tester/);
    expect(text).toContain("groups/***/items/ABCD2345");
  });

  it("CR-02b scrub-report: gruppo configurato senza ZOTERO_TEST_GROUP_NAME → exit 1, nulla scritto (fallisce chiuso)", async () => {
    const { ZOTERO_TEST_GROUP_NAME: _name, ...env } = ENV;
    const r = await node("test/live/scrub-report.mjs", ["out", "in"], env, dir.path);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/ZOTERO_TEST_GROUP_NAME missing/);
    await expect(stat(join(dir.path, "out"))).rejects.toThrow();
  });

  it("CR-02c redact: nome del gruppo sostituito da un token; senza il nome con un gruppo configurato → exit 1", async () => {
    const r = await node("test/live/agent/redact.mjs", ["redact", "in"], ENV, dir.path);
    expect(r.code).toBe(0);
    const text = await readFile(join(dir.path, "in", "report.json"), "utf8");
    expect(text).toContain("library mzt-redacted-group-name,");
    expect(text).not.toContain(GROUP);
    const { ZOTERO_TEST_GROUP_NAME: _name, ...env } = ENV;
    const missing = await node("test/live/agent/redact.mjs", ["redact", "in"], env, dir.path);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toMatch(/ZOTERO_TEST_GROUP_NAME missing/);
  });
});

describe("riepilogo dell'agente smoke (test/live/agent/summary.mjs, CR-03)", () => {
  const verdict = {
    run_id: "r1",
    verified: false,
    problems: ["X1: call 1 (search_library): call_no 9 not in the audit"],
    warnings: ["denied by the hooks: Bash (x)"],
    checks: 41,
    exploratory_calls: [{ scenario: "X1", call_no: 7, tool: "search_library", input: '{"limit":-1}' }],
  };
  const claims = {
    scenarios: [{ id: "F1", status: "skipped", notes: "doi.org | down\nretry" }, { id: "F2", status: "passed" }],
    exploratory: [{ id: "X1", verdict: "unclear", rationale: "limit <0> @someone", observed: "error `x`" }],
    friction: [{ tool: "claims-friction", note: "not used when the report has friction" }],
  };
  const report = { summary: "All good", scenarios: [], friction: [{ tool: "get_item_fulltext", note: "max_characters 0 is unclear" }] };

  it("CR-03a verdetto, problemi, avvisi, tabella scenari, esplorativi, friction, turni/durata senza costo, marcatore in testa", () => {
    const text = buildSummary({ verdict, report, claims, stats: { turns: 87, durationMs: 23 * 60_000, costUsd: 1.844, subtype: "success" }, headSha: "abcdef1234567" });
    expect(text.split("\n")[0]).toBe(MARKER);
    expect(text).toContain("### Agent smoke: claims NOT verified");
    expect(text).toContain("head abcdef1 · 41 checks passed · 1 problems · 1 warnings · 87 turns · 23 min");
    expect(text).not.toMatch(/\$\d/);
    expect(text).toContain("- X1: call 1 (search_library): call_no 9 not in the audit");
    expect(text).toContain("| F1 | skipped | doi.org \\| down retry |");
    expect(text).toContain("| ID | Verdict | Rationale | Audited calls | Observed |");
    expect(text).toContain(`| X1 | unclear | limit &lt;0&gt; @​someone | #7 search_library {"limit":-1} | error 'x' |`);
    expect(text).toContain("- **get_item_fulltext**: max_characters 0 is unclear");
    expect(text).not.toContain("claims-friction");
    expect(text).toContain("<details><summary>Agent report</summary>");
  });

  it("CR-03b senza verdetto e senza statistiche → titolo esplicito; testo dell'agente senza HTML né menzioni, troncato", () => {
    expect(buildSummary({})).toContain("### Agent smoke: no verdict");
    expect(inline("<img src=x> @me | a\nb")).toBe("&lt;img src=x&gt; @​me \\| a b");
    expect(inline("x".repeat(400))).toHaveLength(300);
  });

  it("CR-03c runStats: ultimo messaggio result della trascrizione", () => {
    expect(runStats([{ type: "assistant" }, { type: "result", subtype: "success", num_turns: 3, duration_ms: 120000, total_cost_usd: 0.5 }])).toEqual({ turns: 3, durationMs: 120000, subtype: "success" });
    expect(runStats([])).toBeNull();
    expect(runStats(null)).toBeNull();
  });

  it.each<[string, string, Record<string, string>, RegExp | null]>([
    ["testo pulito con i segnaposto di redact", "users/100000000000001 groups/200000000000002 users/***", ENV, null],
    ["user id", "library users/7654321", ENV, /ZOTERO_TEST_USER_ID present/],
    ["nome del gruppo", `group ${GROUP}`, ENV, /ZOTERO_TEST_GROUP_NAME present/],
    ["percorso users/<id> qualsiasi, anche senza variabili", "http://zotero.org/users/123/items/X", {}, /1 users\/<id> or groups\/<id> path/],
    ["gruppo senza nome nell'ambiente", "ok", { ZOTERO_TEST_GROUP_ID: "8765432" }, /ZOTERO_TEST_GROUP_NAME missing/],
  ])("CR-03d controllo prima di pubblicare: %s", (_label, text, env, re) => {
    const problems = leakProblems(text, env);
    if (re) expect(problems.join("\n")).toMatch(re);
    else expect(problems).toEqual([]);
  });

  it("CR-03f controllo anche sul testo prima dell'escape: un segreto con & o < non sfugge", () => {
    const env = { ZOTERO_TEST_GROUP_NAME: "Lab <A&B>" };
    const input = { verdict: { ...verdict, problems: ["group Lab <A&B> seen"] } };
    expect(leakProblems(buildSummary(input), env)).toEqual([]); // escaped: &lt;A&amp;B&gt;
    expect(leakProblems(buildSummary(input, { raw: true }), env)).toEqual(["ZOTERO_TEST_GROUP_NAME present in the text"]);
  });

  it("CR-03e come processo: scrive il file se pulito; con un identificativo → exit 1 e nessun file", async () => {
    const dir = await tempDir();
    try {
      await mkdir(join(dir.path, "a"));
      await writeFile(join(dir.path, "a", "verdict.json"), JSON.stringify({ ...verdict, problems: [] }));
      await writeFile(join(dir.path, "a", "agent-report.json"), JSON.stringify(report));
      await writeFile(join(dir.path, "a", "execution.json"), JSON.stringify([{ type: "result", num_turns: 2, duration_ms: 60000, total_cost_usd: 0.1 }]));
      const ok = await node("test/live/agent/summary.mjs", ["a", "--out", "s.md"], ENV, dir.path);
      expect(ok.code).toBe(0);
      expect(await readFile(join(dir.path, "s.md"), "utf8")).toMatch(/2 turns · 1 min\n/);
      await writeFile(join(dir.path, "a", "verdict.json"), JSON.stringify({ ...verdict, problems: [`created entry users/${ENV.ZOTERO_TEST_USER_ID}`] }));
      const leak = await node("test/live/agent/summary.mjs", ["a", "--out", "leak.md"], ENV, dir.path);
      expect(leak.code).toBe(1);
      expect(leak.stderr).toMatch(/not written/);
      expect(leak.stderr).not.toContain(ENV.ZOTERO_TEST_USER_ID);
      await expect(stat(join(dir.path, "leak.md"))).rejects.toThrow();
    } finally {
      await dir.cleanup();
    }
  });
});
