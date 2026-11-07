import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
// @ts-expect-error plain .mjs script without type declarations
import { liveScope } from "../../scripts/live-scope.mjs";
// @ts-expect-error plain .mjs script without type declarations
import { wordProxyScope, loProxyScope } from "../../scripts/word-proxy-scope.mjs";
// @ts-expect-error plain .mjs script without type declarations
import { previousRun, requiredJobs } from "../../scripts/duplicate-run.mjs";

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
    // a new release only for the package.json version, tagged on the tested commit
    const create = step(zips, "Resolve or create release");
    expect(create.indexOf('if [ "${TAG#v}" != "$VERSION" ]; then')).toBeGreaterThan(0);
    expect(create.indexOf('if [ "${TAG#v}" != "$VERSION" ]; then')).toBeLessThan(create.indexOf("gh release create"));
    expect(create).toContain('gh release create "$TAG" --target "$GITHUB_SHA"');
  });

  it("WL-06c la issue settimanale si apre anche senza report (download non bloccante), comandi gh con timeout", () => {
    const weekly = job(agent, "weekly-issue");
    expect(weekly).toMatch(/download-artifact@[0-9a-f]{40} # [^\n]+\n {8}# [^\n]+\n {8}continue-on-error: true/);
    for (const m of weekly.matchAll(/\bgh issue (list|comment|create)\b/g)) expect(weekly.slice(Math.max(0, m.index! - 11), m.index)).toBe("timeout 60 ");
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
    for (const [perm, only] of [["id-token: write", "agent-run"], ["issues: write", "weekly-issue"], ["pull-requests: write", "comment"], ["actions: write", "word-render-cleanup"]]) {
      const keys = jobKeys(agent).filter((k) => job(agent, k).includes(perm));
      expect(keys, perm).toEqual([only]);
    }
    expect(agent).toMatch(/schedule:\n {4}# [^\n]+\n {4}- cron: "23 3 \* \* 5"/);
    expect(agent).toContain('options: ["live+agent", "live"]');
    // word-render: between the live suite and the agent, same conditions, no secrets; no pages → no agent
    const render = job(agent, "word-render");
    expect(render).toContain("needs: [changes, live]");
    expect(render).toContain("needs.changes.outputs.agent == 'true' &&\n      needs.live.result == 'success' &&");
    expect(render).not.toMatch(/secrets\.|environment:|id-token/);
    expect(render).toContain("uses: ./.github/actions/word-tools");
    // LibreOffice pages (lo-apa/lo-ieee/lo-group) rendered into the same artifact; the fail-closed check is last (F)
    expect(render).toContain("uses: ./.github/actions/libreoffice-tools");
    expect(step(render, "Render the Word pages")).toContain("node test/word-proxy/render.mjs");
    expect(step(render, "Render the LibreOffice pages and check the artifact")).toContain("node test/lo-proxy/render.mjs");
    expect(step(render, "Render the LibreOffice pages and check the artifact")).toContain("node test/word-proxy/check-artifacts.mjs");
    expect(render).toContain("retention-days: 1");
    expect(job(agent, "agent-run")).toContain("needs: [prepare, word-render]");
    expect(job(agent, "agent-run")).toContain("needs.word-render.result == 'success'");
    expect(verdict).toContain('if [ "$RENDER" != "success" ]; then');
    // the agent config comes from the base branch like the skill and hooks; the audited page reads reach the verifier
    expect(step(job(agent, "agent-run"), "Agent configuration from the base branch")).toContain(".github/agents/agent-smoke.json; do");
    expect(step(job(agent, "agent-run"), "Collect the agent output")).toContain("image-reads.jsonl");
    const cleanup = job(agent, "word-render-cleanup");
    expect(cleanup).toContain("if: always() && needs.word-render.result != 'skipped'");
    expect(cleanup).toContain('gh api -X DELETE "repos/$REPO/actions/artifacts/$id"');
    expect(cleanup).not.toMatch(/secrets\.|checkout|npm /);
    // every job and step with a timeout; actions pinned by SHA
    for (const k of jobKeys(agent)) expect(job(agent, k), k).toMatch(/\n {4}timeout-minutes: \d+/);
    for (const m of agent.matchAll(/uses: ([^\s]+)/g)) expect(m[1]).toMatch(/@[0-9a-f]{40}$|^\.\/\.github\/actions\//);
    const steps = agent.split(/\n {6}- /).slice(1);
    for (const st of steps) expect(st, st.slice(0, 60)).toMatch(/\n {8}timeout-minutes: \d+|^\S[^\n]*\n(?: {8}[^\n]*\n)*? {8}timeout-minutes: \d+/);
    expect(workflow("deps-update.yml")).toContain('gh workflow run claude-agent-smoke.yml --repo "$REPO" --ref "$BRANCH" -f scope=live+agent');
    expect(workflow("deps-update.yml")).not.toContain("live-tests.yml");
  });
});

describe("run doppie sullo stesso commit delle PR in stack (scripts/duplicate-run.mjs, WL-11)", () => {
  const run = (id: number, conclusion: string | null, created: string, status = "completed") => ({
    id,
    status,
    conclusion,
    created_at: created,
    html_url: `https://github.com/o/r/actions/runs/${id}`,
  });
  const ok = (...names: string[]) => names.map((name) => ({ name, conclusion: "success" }));
  const BOTH = { live: true, agent: true };

  it("WL-11 run precedente riuscita con live e agente → duplicate, link alla più recente", async () => {
    const jobs: Record<number, unknown[]> = {
      1: ok("changes", "live-tests-run", "agent-smoke-run", "agent-smoke-verify"),
      2: ok("changes", "live-tests-run", "agent-smoke-run", "agent-smoke-verify"),
    };
    const prev = await previousRun([run(1, "success", "2026-10-20T10:00:00Z"), run(2, "success", "2026-10-20T11:00:00Z")], async (id: number) => jobs[id], BOTH, 3);
    expect(prev).toEqual({ id: 2, url: "https://github.com/o/r/actions/runs/2" });
  });

  it.each<[string, ReturnType<typeof run>, unknown[]]>([
    ["fallita", run(1, "failure", "2026-10-20T10:00:00Z"), ok("live-tests-run", "agent-smoke-run", "agent-smoke-verify")],
    ["annullata", run(1, "cancelled", "2026-10-20T10:00:00Z"), ok("live-tests-run")],
    ["ancora in corso", run(1, null, "2026-10-20T10:00:00Z", "in_progress"), ok("live-tests-run")],
    ["riuscita ma senza agente (fuori ambito allora, o attore diverso)", run(1, "success", "2026-10-20T10:00:00Z"), [...ok("live-tests-run"), { name: "agent-smoke-run", conclusion: "skipped" }]],
    ["riuscita ma doppia a sua volta (live saltato)", run(1, "success", "2026-10-20T10:00:00Z"), [{ name: "live-tests-run", conclusion: "skipped" }]],
  ])("WL-11b run precedente %s → si procede normalmente", async (_label, r, jobs) => {
    expect(await previousRun([r], async () => jobs, BOTH, 3)).toBeNull();
  });

  it("WL-11c la run corrente non conta; solo live → basta live-tests-run; nulla in ambito → mai duplicate", async () => {
    const jobs = async () => ok("live-tests-run");
    expect(await previousRun([run(3, "success", "2026-10-20T10:00:00Z")], jobs, { live: true, agent: false }, 3)).toBeNull();
    expect(await previousRun([run(1, "success", "2026-10-20T10:00:00Z")], jobs, { live: true, agent: false }, 3)).toEqual(expect.objectContaining({ id: 1 }));
    expect(requiredJobs({ live: false, agent: false })).toEqual([]);
    expect(await previousRun([run(1, "success", "2026-10-20T10:00:00Z")], jobs, { live: false, agent: false }, 3)).toBeNull();
  });

  it("WL-11d come processo, senza token o con un errore → duplicate=false (la run procede)", () => {
    const out = execFileSync(process.execPath, [join(ROOT, "scripts", "duplicate-run.mjs")], {
      env: { PATH: process.env.PATH ?? "", REPO: "o/r", HEAD_SHA: "0".repeat(40), LIVE: "true", AGENT: "true" },
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 10_000,
    }).toString();
    expect(out).toBe("duplicate=false\n");
  });

  it("WL-11e workflow: changes con actions: read; live saltato se duplicate; verdetti verdi con il link nel Job Summary", () => {
    const text = readFileSync(join(ROOT, ".github", "workflows", "claude-agent-smoke.yml"), "utf8");
    const jobs = text.slice(text.indexOf("\njobs:\n"));
    const changes = jobs.slice(jobs.indexOf("\n  changes:\n"), jobs.indexOf("\n  live:\n"));
    expect(changes).toMatch(/permissions:\n {6}contents: read\n(?: {6}#[^\n]*\n)? {6}actions: read\n/);
    expect(changes).toContain("duplicate: ${{ steps.duplicate.outputs.duplicate }}");
    expect(step(changes, "Earlier successful run on the same commit")).toContain("if: github.event_name == 'pull_request'");
    expect(step(changes, "Earlier successful run on the same commit")).toContain("HEAD_SHA: ${{ github.event.pull_request.head.sha }}");
    expect(jobs).toContain("needs.changes.outputs.live == 'true' &&\n      needs.changes.outputs.duplicate != 'true' &&");
    for (const name of ["live-tests", "agent-smoke"]) {
      const verdict = jobs.slice(jobs.indexOf(`name: ${name} # required check name`));
      const dup = verdict.indexOf('if [ "$DUPLICATE" = "true" ]; then');
      expect(dup, name).toBeGreaterThan(verdict.indexOf('if [ "$RELEVANT" != "true" ]; then'));
      expect(verdict.slice(dup, dup + 400)).toContain('$PREVIOUS_URL" >> "$GITHUB_STEP_SUMMARY"');
      // the duplicate check comes before anything that would read the skipped jobs as a failure
      expect(dup).toBeLessThan(verdict.indexOf("case \"$LIVE\" in") > 0 ? verdict.indexOf("case \"$LIVE\" in") : verdict.indexOf('if [ "$PREPARE" = "skipped" ]'));
    }
  });
});

describe("lock e identificativi nei job dell'agente (WL-12)", () => {
  const text = readFileSync(join(ROOT, ".github", "workflows", "claude-agent-smoke.yml"), "utf8");
  const jobText = (t: string, key: string) => {
    const jobs = t.slice(t.indexOf("\njobs:\n"));
    const start = jobs.indexOf(`\n  ${key}:\n`);
    const rest = jobs.slice(start + 1);
    const end = rest.slice(1).search(/\n {2}[a-z][\w-]*:\n/);
    return end < 0 ? rest : rest.slice(0, end + 1);
  };

  it("WL-12 run_id scritto prima del lock; prepare rilascia se fallisce o è annullato; cleanup rilascia sempre", () => {
    const prepare = jobText(text, "prepare");
    expect(prepare.indexOf('echo "run_id=')).toBeGreaterThan(0);
    expect(prepare.indexOf('echo "run_id=')).toBeLessThan(prepare.indexOf("- name: Lock the test account"));
    expect(step(prepare, "Release the lock if prepare failed")).toContain("if: (failure() || cancelled()) && steps.prepare.outputs.run_id != ''");
    const cleanup = jobText(text, "cleanup");
    expect(cleanup).toContain("if: always() && needs.prepare.outputs.run_id != ''");
    const release = step(cleanup, "Release the test-account lock");
    expect(release).toContain("if: always()");
    expect(release).toContain('node test/live/lock.mjs release "$RUN_ID"');
  });

  it("WL-12b gli id della federazione Anthropic mascherati come primo step dei job dell'agente", () => {
    const deps = readFileSync(join(ROOT, ".github", "workflows", "deps-update.yml"), "utf8");
    for (const [t, key] of [[text, "prepare"], [text, "agent-run"], [deps, "agent"]] as const) {
      const j = jobText(t, key);
      const steps = j.split(/\n {6}- /).slice(1);
      expect(steps[0], key).toMatch(/^name: Mask the Anthropic federation ids\n/);
      for (const v of ["FEDERATION_RULE_ID", "ORGANIZATION_ID", "SERVICE_ACCOUNT_ID", "WORKSPACE_ID"]) {
        expect(steps[0]).toContain(`${v}: \${{ vars.ANTHROPIC_${v} }}`);
      }
      expect(steps[0]).toContain('if [ -n "$v" ]; then echo "::add-mask::$v"; fi');
    }
  });
});

describe("ambito di una run del workflow dal vivo (scripts/live-scope.mjs, WL-08)", () => {
  it.each<[string, string, string[], string, { live: boolean; agent: boolean }]>([
    ["PR solo docs", "pull_request", ["README.md", "docs/x.md"], "", { live: false, agent: false }],
    ["PR sul codice", "pull_request", ["src/tools/search-library.ts"], "", { live: true, agent: true }],
    ["PR sul live suite", "pull_request", ["test/live/search-library.live.test.ts"], "", { live: true, agent: false }],
    ["PR solo sulla skill dell'agente (il live gira comunque prima)", "pull_request", [".claude/skills/test-mcp-zotero/SKILL.md"], "", { live: true, agent: true }],
    ["PR sul workflow", "pull_request", [".github/workflows/claude-agent-smoke.yml"], "", { live: true, agent: true }],
    ["PR sui test lo-proxy (pagine LO del word-render)", "pull_request", ["test/lo-proxy/run.sh"], "", { live: true, agent: true }],
    ["PR sull'azione libreoffice-tools", "pull_request", [".github/actions/libreoffice-tools/action.yml"], "", { live: true, agent: true }],
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

describe("job word-proxy di test.yml (WL-09, WL-10)", () => {
  it.each<[string, string, string[], boolean]>([
    ["PR solo docs", "pull_request", ["README.md", "test/WORD_CHECKLIST.md"], false],
    ["PR solo sui test unitari", "pull_request", ["test/tools/search-library.test.ts"], false],
    ["PR su qualunque sorgente del server (i documenti passano da tutto il server)", "pull_request", ["src/utils/zotero-keys.ts"], true],
    ["PR sull'iniettore", "pull_request", ["src/citation-injector/injector.ts"], true],
    ["PR sulla conversione in itemData", "pull_request", ["src/utils/csl-to-zotero.ts"], true],
    ["PR sulla skill (inject.js)", "pull_request", ["skills/zotero-skill-mcp-integrations/scripts/inject.js"], true],
    ["PR sul corpus", "pull_request", ["test/fixtures/corpus/library.json"], true],
    ["PR sull'azione word-tools", "pull_request", [".github/actions/word-tools/action.yml"], true],
    ["push su main", "push", [], true],
    ["manuale", "workflow_dispatch", [], true],
  ])("WL-09 %s", (_label, event, files, expected) => {
    expect(wordProxyScope(event, files)).toBe(expected);
  });

  it("WL-10 if a livello di job (non on.paths), nessun segreto, runner fissato, timeout, artifact solo dopo il controllo", () => {
    const test = workflow("test.yml");
    expect(test).not.toMatch(/^\s+paths:/m);
    const job = test.slice(test.indexOf("\n  word-proxy:\n"), test.indexOf("\n  lo-proxy:\n"));
    expect(job).toContain("needs: word-proxy-scope");
    expect(job).toContain("if: needs.word-proxy-scope.outputs.run == 'true'");
    expect(job).toContain("runs-on: ubuntu-24.04");
    expect(Number(job.match(/\n    timeout-minutes: (\d+)/)![1])).toBeLessThanOrEqual(10);
    expect(job).not.toMatch(/secrets\.|environment:|id-token/);
    expect(job).toContain("uses: ./.github/actions/word-tools");
    expect(step(job, "Collect and check the artifact")).toContain("node test/word-proxy/check-artifacts.mjs");
    const upload = step(job, "Upload documents, traces and reports");
    expect(upload).toContain("steps.artifact.outcome == 'success'");
    expect(upload).toContain("retention-days: 1");
    for (const s of job.split(/\n {6}- /).slice(1)) expect(s, s.split("\n")[0]).toMatch(/timeout-minutes: \d+/);
    const action = readFileSync(join(ROOT, ".github", "actions", "word-tools", "action.yml"), "utf8");
    expect(action.match(/sha256=[0-9a-f]{64}/g)).toHaveLength(4);
    expect(action).toContain("sha256sum -c -");
    // the archives are checked on every run, a cache hit included
    expect(action).not.toMatch(/if: steps\.cache\.outputs\.cache-hit/);
    expect(action).toMatch(/actions\/cache@[0-9a-f]{40}/);
  });
});

describe("job lo-proxy di test.yml (#37, LibreOffice + Zotero .oxt)", () => {
  it.each<[string, string, string[], boolean]>([
    ["PR solo docs", "pull_request", ["README.md", "test/WORD_CHECKLIST.md"], false],
    ["PR solo sui test unitari", "pull_request", ["test/tools/search-library.test.ts"], false],
    ["PR su qualunque sorgente del server (lo scrittore odt sta nel server)", "pull_request", ["src/citation-injector/injector.ts"], true],
    ["PR sulla skill (inject.js)", "pull_request", ["skills/zotero-skill-mcp-integrations/scripts/inject.js"], true],
    ["PR sul corpus", "pull_request", ["test/fixtures/corpus/library.json"], true],
    ["PR sui test lo-proxy", "pull_request", ["test/lo-proxy/verify.mjs"], true],
    ["PR sul plugin condiviso word-proxy", "pull_request", ["test/word-proxy/plugin/bootstrap.js"], true],
    ["PR sull'azione libreoffice-tools", "pull_request", [".github/actions/libreoffice-tools/action.yml"], true],
    ["PR sull'azione word-tools (fornisce Zotero e l'.oxt)", "pull_request", [".github/actions/word-tools/action.yml"], true],
    ["push su main", "push", [], true],
    ["manuale", "workflow_dispatch", [], true],
  ])("%s", (_label, event, files, expected) => {
    expect(loProxyScope(event, files)).toBe(expected);
  });

  it("job non obbligatorio, nessun segreto, runner fissato, timeout <= 15, artifact solo dopo il controllo", () => {
    const test = workflow("test.yml");
    const job = test.slice(test.indexOf("\n  lo-proxy:\n"));
    expect(job).toContain("needs: word-proxy-scope");
    expect(job).toContain("if: needs.word-proxy-scope.outputs.lo == 'true'");
    expect(job).toContain("runs-on: ubuntu-24.04");
    expect(Number(job.match(/\n    timeout-minutes: (\d+)/)![1])).toBeLessThanOrEqual(15);
    expect(job).not.toMatch(/secrets\.|environment:|id-token/);
    expect(job).toContain("uses: ./.github/actions/word-tools");
    expect(job).toContain("uses: ./.github/actions/libreoffice-tools");
    expect(step(job, "Collect and check the artifact")).toContain("node test/word-proxy/check-artifacts.mjs");
    const upload = step(job, "Upload documents, driver logs and reports");
    expect(upload).toContain("steps.artifact.outcome == 'success'");
    expect(upload).toContain("retention-days: 1");
    for (const s of job.split(/\n {6}- /).slice(1)) expect(s, s.split("\n")[0]).toMatch(/timeout-minutes: \d+/);
    const action = readFileSync(join(ROOT, ".github", "actions", "libreoffice-tools", "action.yml"), "utf8");
    // one sha256 per architecture (x86_64 for CI, aarch64 for local), checked on every run (cache hit included)
    expect(action.match(/sha256=[0-9a-f]{64}/g)).toHaveLength(2);
    expect(action).toContain("sha256sum -c -");
    expect(action).not.toMatch(/if: steps\.cache\.outputs\.cache-hit/);
    expect(action).toMatch(/actions\/cache@[0-9a-f]{40}/);
  });
});
