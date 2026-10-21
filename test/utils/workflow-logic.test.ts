import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
// @ts-expect-error plain .mjs script without type declarations
import { liveScope } from "../../scripts/live-scope.mjs";

/**
 * Logica dei workflow dal vivo che nessun test esegue (gira solo su GitHub): controlli testuali sulle condizioni
 * che decidono i check obbligatori, perché una modifica che li rende "verdi senza verifica" non passi inosservata.
 */
const ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const workflow = (name: string) => readFileSync(join(ROOT, ".github", "workflows", name), "utf8");

/** Text of the step with this name, up to the next step or job. */
function step(text: string, name: string): string {
  const start = text.indexOf(`- name: ${name}`);
  expect(start, `step "${name}"`).toBeGreaterThanOrEqual(0);
  const rest = text.slice(start + 1);
  const end = rest.search(/\n {6}- |\n {2}[a-z][\w-]*:\n/);
  return end < 0 ? rest : rest.slice(0, end);
}

describe("workflow dal vivo e agente smoke (WL)", () => {
  // one workflow for both (claude-agent-smoke.yml: the federation rule of the agent job names this file)
  const agent = workflow("claude-agent-smoke.yml");
  const live = agent;

  it("WL-01 verify-claims gira sempre dopo un agente riuscito (audit mancante = fallimento), dopo un agente fallito solo con l'audit", () => {
    expect(step(agent, "Verify the agent's claims")).toContain(
      "if: needs.prepare.outputs.run_id != '' && (hashFiles('agent-out/audit.jsonl') != '' || needs.agent-run.result == 'success')"
    );
    expect(step(agent, "No agent calls recorded")).toContain("&& needs.agent-run.result != 'success'");
  });

  it("WL-02 i check obbligatori girano con !cancelled() e verificano changes; il verdetto dell'agente richiede verify riuscito", () => {
    for (const [text, name] of [[agent, "agent-smoke"], [live, "live-tests"]] as const) {
      const job = text.slice(text.indexOf(`name: ${name} # required check name`));
      expect(job.slice(0, 200)).toContain("if: ${{ !cancelled() }}");
      expect(job).toContain('if [ "$CHANGES" != "success" ]; then');
    }
    expect(agent).toContain('if [ "$VERIFY" != "success" ]; then echo "::error::agent-smoke-verify: $VERIFY"; exit 1; fi');
  });

  it("WL-03 una run dal vivo o dell'agente in corso non viene annullata da un push più recente", () => {
    for (const text of [agent, live]) expect(text).toMatch(/concurrency:\n {2}group: [^\n]+\n {2}cancel-in-progress: false\n/);
  });

  /** Text of a job, from its key line to the next job (without the comment lines that introduce the next one). */
  const job = (text: string, key: string) => {
    const jobs = text.slice(text.indexOf("\njobs:\n"));
    const start = jobs.indexOf(`\n  ${key}:\n`);
    expect(start, `job "${key}"`).toBeGreaterThanOrEqual(0);
    const rest = jobs.slice(start + 1);
    const end = rest.slice(1).search(/\n {2}[a-z][\w-]*:\n/);
    return (end < 0 ? rest : rest.slice(0, end + 1)).replace(/(?:\n {2}#[^\n]*)+\n*$/, "\n");
  };
  const jobKeys = (text: string) => [...text.slice(text.indexOf("\njobs:\n")).matchAll(/\n {2}([a-z][\w-]*):\n/g)].map((m) => m[1]);

  it("WL-04 ogni job che usa la chiave di test maschera prima il nome del gruppo (primo step che tocca l'account)", () => {
    for (const [text, keys] of [[agent, ["prepare", "agent-run", "verify", "cleanup"]], [live, ["live"]]] as const) {
      for (const key of keys) {
        const j = job(text, key);
        const mask = j.indexOf("- name: Mask the test group name");
        expect(mask, `${key}: mask step`).toBeGreaterThan(0);
        expect(step(j, "Mask the test group name")).toContain("run: node test/live/mask-group-name.mjs");
        // no other step reads a Zotero secret before it
        expect(j.slice(0, mask)).not.toMatch(/secrets\.ZOTERO_TEST_/);
      }
    }
  });

  it("WL-05 artifact e riepiloghi pubblicati solo dopo uno scrub riuscito; commento con solo pull-requests: write, senza checkout né segreti", () => {
    expect(step(agent, "Upload scrubbed agent output")).toContain("if: always() && steps.scrub.outcome == 'success'");
    expect(step(live, "Upload scrubbed report")).toContain("if: always() && steps.scrub.outcome == 'success'");
    expect(step(agent, "Job summary")).toContain("if: always() && steps.scrub.outcome == 'success'");
    expect(step(agent, "Job summary")).toContain("node test/live/agent/summary.mjs live-artifacts/agent-out --out live-artifacts/summary.md");
    const comment = job(agent, "comment");
    expect(comment).toMatch(/ {4}permissions:\n {6}pull-requests: write\n {4}steps:/);
    expect(comment).toContain("github.event.pull_request.head.repo.full_name == github.repository");
    expect(comment).not.toMatch(/actions\/checkout|npm |secrets\.|environment:/);
    expect(comment).toContain("grep -Evx 'users/100000000000001|groups/200000000000002'");
  });

  it("WL-06 npm-publish pubblica il tag della release e solo se package.json ha la sua versione", () => {
    const release = workflow("release.yml");
    const publish = job(release, "npm-publish");
    expect(publish).toContain("needs: [test, skill-zips]");
    expect(publish).toContain("ref: ${{ github.event.release.tag_name || inputs.tag }}");
    const check = publish.indexOf("- name: Check package.json version = release tag");
    expect(check).toBeGreaterThan(0);
    expect(check).toBeLessThan(publish.indexOf("npm publish"));
    expect(step(publish, "Check package.json version = release tag")).toContain('if [ "${TAG#v}" != "$VERSION" ]; then');
    // test: the tag if it exists already; skill-zips: zips from the tag, after creating it if needed
    expect(step(job(release, "test"), "Check out the release tag if it exists")).toContain('git checkout --detach "refs/tags/$TAG"');
    const zips = job(release, "skill-zips");
    expect(zips.indexOf("- name: Resolve or create release")).toBeLessThan(zips.indexOf("- name: Check out the release tag"));
    expect(zips.indexOf("- name: Check out the release tag")).toBeLessThan(zips.indexOf("- name: Create skill zip archives"));
    expect(step(zips, "Check out the release tag")).toContain('if [ "${TAG#v}" != "$VERSION" ]; then');
  });

  it("WL-06b il job di pulizia dell'agente pulisce anche se il mascheramento del nome del gruppo fallisce", () => {
    expect(step(job(agent, "cleanup"), "Mask the test group name")).toContain("continue-on-error: true");
    for (const k of ["prepare", "agent-run", "verify", "live"]) expect(step(job(agent, k), "Mask the test group name")).not.toContain("continue-on-error");
  });

  it("WL-07 un solo workflow: changes → live → agente solo dopo un live riuscito; verdetti con i nomi dei check obbligatori; permessi minimi", () => {
    expect(existsSync(join(ROOT, ".github", "workflows", "live-tests.yml"))).toBe(false);
    expect(job(agent, "changes")).toContain("node scripts/live-scope.mjs");
    expect(job(agent, "live")).toContain("needs.changes.outputs.live == 'true' &&");
    const prepare = job(agent, "prepare");
    expect(prepare).toContain("needs: [changes, live]");
    expect(prepare).toContain("needs.changes.outputs.agent == 'true' &&\n      needs.live.result == 'success' &&");
    expect(job(agent, "live-verdict")).toMatch(/name: live-tests # required check name\n {4}needs: \[changes, live\]/);
    expect(job(agent, "live-verdict")).toContain("RELEVANT: ${{ needs.changes.outputs.live }}");
    const verdict = job(agent, "agent-verdict");
    expect(verdict).toContain("name: agent-smoke # required check name");
    expect(verdict).toContain("RELEVANT: ${{ needs.changes.outputs.agent }}");
    expect(verdict).toContain('elif [ "$LIVE" != "success" ]; then');
    // id-token only in the agent job, issues: write only in the weekly issue job, pull-requests: write only in comment
    for (const [perm, only] of [["id-token: write", "agent-run"], ["issues: write", "weekly-issue"], ["pull-requests: write", "comment"]]) {
      const keys = jobKeys(agent).filter((k) => job(agent, k).includes(perm));
      expect(keys, perm).toEqual([only]);
    }
    expect(agent).toMatch(/schedule:\n {4}# [^\n]+\n {4}- cron: "23 3 \* \* 5"/);
    expect(agent).toContain('options: ["live+agent", "live"]');
    expect(agent).toContain("# ── Slot: word-render");
    // every job and step with a timeout; actions pinned by SHA
    for (const k of jobKeys(agent)) expect(job(agent, k), k).toMatch(/\n {4}timeout-minutes: \d+/);
    for (const m of agent.matchAll(/uses: ([^\s]+)/g)) expect(m[1]).toMatch(/@[0-9a-f]{40}$/);
    const steps = agent.split(/\n {6}- /).slice(1);
    for (const st of steps) expect(st, st.slice(0, 60)).toMatch(/\n {8}timeout-minutes: \d+|^\S[^\n]*\n(?: {8}[^\n]*\n)*? {8}timeout-minutes: \d+/);
    expect(workflow("deps-update.yml")).toContain('gh workflow run claude-agent-smoke.yml --repo "$REPO" --ref "$BRANCH" -f scope=live+agent');
    expect(workflow("deps-update.yml")).not.toContain("live-tests.yml");
  });
});

describe("ambito di una run del workflow dal vivo (scripts/live-scope.mjs, WL-08)", () => {
  it.each<[string, string, string[], string, { live: boolean; agent: boolean }]>([
    ["PR solo docs", "pull_request", ["README.md", "docs/x.md"], "", { live: false, agent: false }],
    ["PR sul codice", "pull_request", ["src/tools/search-library.ts"], "", { live: true, agent: true }],
    ["PR sul live suite", "pull_request", ["test/live/search-library.live.test.ts"], "", { live: true, agent: false }],
    ["PR solo sulla skill dell'agente (il live gira comunque prima)", "pull_request", [".claude/skills/test-mcp-zotero/SKILL.md"], "", { live: true, agent: true }],
    ["PR sul workflow", "pull_request", [".github/workflows/claude-agent-smoke.yml"], "", { live: true, agent: true }],
    ["push su main", "push", [], "", { live: true, agent: false }],
    ["schedule", "schedule", [], "", { live: true, agent: false }],
    ["manuale senza input (default)", "workflow_dispatch", [], "", { live: true, agent: true }],
    ["manuale live", "workflow_dispatch", [], "live", { live: true, agent: false }],
    ["manuale live+agent", "workflow_dispatch", [], "live+agent", { live: true, agent: true }],
  ])("WL-08 %s", (_label, event, files, scope, expected) => {
    expect(liveScope(event, files, scope)).toEqual(expected);
  });

  it("WL-08b scope sconosciuto → errore; come processo scrive live=/agent= per $GITHUB_OUTPUT", () => {
    expect(() => liveScope("workflow_dispatch", [], "agent")).toThrow(/scope must be one of/);
    const out = execFileSync(process.execPath, [join(ROOT, "scripts", "live-scope.mjs")], {
      env: { PATH: process.env.PATH ?? "", EVENT: "pull_request" },
      input: "README.md\nsrc/server.ts\n",
      timeout: 10_000,
    }).toString();
    expect(out).toBe("live=true\nagent=true\n");
  });
});
