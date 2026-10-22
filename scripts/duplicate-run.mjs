#!/usr/bin/env node
// Duplicate runs of the live workflow on stacked PRs: a force-push of the base branch sends a second `synchronize`
// for the same head commit, and the live suite and the agent would run again on code they already passed on. For
// the `changes` job: duplicate=true when an earlier run of this workflow on the same head SHA completed with
// success and ran (successfully) every part this run would run (live-tests-run; agent-smoke-run and
// agent-smoke-verify when the agent is in scope). A failed, cancelled or still running earlier run, or one that
// skipped a part, does not count, and any error of the lookup means duplicate=false: the run proceeds normally.
// Usage (pull requests only): GH_TOKEN=... REPO=owner/name HEAD_SHA=... RUN_ID=... LIVE=true AGENT=true \
//   node scripts/duplicate-run.mjs >> "$GITHUB_OUTPUT"
import { fileURLToPath } from "node:url";

export const WORKFLOW_FILE = "claude-agent-smoke.yml";
const API = "https://api.github.com";
const REQUEST_TIMEOUT_MS = 20_000;

/** Job names (as GitHub shows them) that must have succeeded in the earlier run, for this run's scope. */
export function requiredJobs({ live, agent }) {
  return [...(live ? ["live-tests-run"] : []), ...(agent ? ["agent-smoke-run", "agent-smoke-verify"] : [])];
}

/**
 * The earlier run that makes this one a duplicate, or null. `runs`: workflow runs on the head SHA (GitHub API
 * objects); `jobsOf(id)`: the jobs of a run (`{ name, conclusion }`).
 * @returns {Promise<{ id: number, url: string } | null>}
 */
export async function previousRun(runs, jobsOf, scope, currentRunId) {
  const needed = requiredJobs(scope);
  if (needed.length === 0) return null;
  const candidates = runs
    .filter((r) => String(r.id) !== String(currentRunId) && r.status === "completed" && r.conclusion === "success")
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
  for (const run of candidates) {
    const jobs = await jobsOf(run.id);
    if (needed.every((name) => jobs.some((j) => j.name === name && j.conclusion === "success"))) return { id: run.id, url: run.html_url };
  }
  return null;
}

async function gh(path, token) {
  const res = await fetch(`${API}/${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`GET ${path.split("?")[0]}: HTTP ${res.status}`);
  return res.json();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { GH_TOKEN = "", REPO = "", HEAD_SHA = "", RUN_ID = "", LIVE = "", AGENT = "" } = process.env;
  const scope = { live: LIVE === "true", agent: AGENT === "true" };
  try {
    if (!GH_TOKEN || !/^[\w.-]+\/[\w.-]+$/.test(REPO) || !/^[0-9a-f]{40}$/.test(HEAD_SHA)) throw new Error("GH_TOKEN, REPO and HEAD_SHA are required");
    const runs = (await gh(`repos/${REPO}/actions/workflows/${WORKFLOW_FILE}/runs?head_sha=${HEAD_SHA}&status=success&per_page=50`, GH_TOKEN)).workflow_runs ?? [];
    const jobsOf = async (id) => (await gh(`repos/${REPO}/actions/runs/${id}/jobs?per_page=100`, GH_TOKEN)).jobs ?? [];
    const prev = await previousRun(runs, jobsOf, scope, RUN_ID);
    process.stdout.write(prev ? `duplicate=true\nprevious_url=${prev.url}\n` : "duplicate=false\n");
  } catch (e) {
    console.error(`::warning::duplicate-run: ${e instanceof Error ? e.message : String(e)} (the run proceeds normally)`);
    process.stdout.write("duplicate=false\n");
  }
}
