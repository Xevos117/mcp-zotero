# CLAUDE.md — instructions for agents working on mcp-zotero

MCP server for the Zotero Web API (TypeScript, ESM, Node >= 22), published on npm as
`@xevos117/mcp-zotero`. Source in `src/`, compiled to `build/` with `tsc` (TypeScript 7).
The product skill lives in `skills/zotero-skill-mcp-integrations/` (standalone `inject.js`,
shipped as a release zip, not in the npm package).

## Hard rules

- **Timeouts everywhere.** Every command that can hang runs under `timeout N` (git network ops,
  npm, vitest, node scripts, gh). Every CI job and step has `timeout-minutes`. Every test has a
  timeout; every network call in code uses `AbortSignal.timeout`. A bound that is hit is a failure
  to investigate, not something to retry blindly.
- **Never merge, publish or release.** No `gh pr merge`, `npm publish`, `gh release create`, tag
  pushes or version bumps unless the owner asks for that specific action. Do not change repository
  settings (rulesets, environments, secrets, workflow permissions).
- **Never print secrets.** Zotero / Anthropic / npm keys are read only from the environment or from
  files passed inline (`VAR="$(cat file)" cmd`); never echo them, log them, commit them or paste
  them in PRs, issues or reports. Scrub keys, user ids and emails from anything you publish.
- **Real Zotero libraries are someone's data.** Live runs only create items/collections prefixed
  `mzt-` and tagged `mzt-run:<runId>`, and delete only what that run created.
- **Never commit run outputs.** `agent-out/`, `agent-audit/`, `.vitest/` and `live-artifacts/` hold
  library content (titles, keys, collection names, user ids). They are gitignored, `test.yml` fails if
  any is tracked (`scripts/check-tracked-artifacts.mjs`), and on a branch whose `.gitignore` predates
  them (e.g. a lower layer of a stack) stage files by name, never with `git add -A` after a live run.

## Conventions

- Commit messages, PR titles/descriptions and `test/TEST_CASES.md` are written in **Italian**.
  Code comments and identifiers are in English. Keep diffs focused; match the surrounding style.
- Never edit `build/` by hand; it is gitignored and produced by `npm run build`.
- Tool errors go through `formatErrorResponse` (`isError: true`); empty results through
  `formatEmptyResult` (no `isError`). Deletions are gated by `UNSAFE_OPERATIONS` (`none|items|all`).
- Distribution metadata lives in `package.json`, `server.json` (MCP Registry) and `manifest.json` (Claude Desktop
  extension, built by `npm run bundle` with `scripts/build-mcpb.mjs`); `test/utils/release-metadata.test.ts` keeps
  versions, environment variables and the tool list in sync, so a new env var or tool means updating both files.
- `.claude/` is ignored except `.claude/skills/` (versioned project skills). `.npmignore` keeps
  `.claude/` and `CLAUDE.md` out of the npm package; `package.json` `files` is `["build"]`.

## Tests

| Command | What runs | Network |
|---|---|---|
| `npm test` | unit + per-tool suites: `src/**/*.test.ts`, `test/**/*.test.ts` (excluding `test/e2e`) | none (fetch faked) |
| `npm run test:e2e` | builds, then `test/e2e/**` against `build/server.js` over stdio | none (fetch redirected to a local fake) |
| `npm run smoke` | `scripts/smoke-stdio.mjs`: built server, user + group library, stubbed fetch; `-- --bundle dist/mcp-zotero.mcpb`: the unpacked Claude Desktop bundle, started from its manifest | none |
| `npm run test:live` | builds, then `test/live/**/*.live.test.ts` against the real Zotero Web API | real (needs `ZOTERO_TEST_API_KEY`, skipped otherwise) |

Run `npm run build`, `npm test`, `npm run test:e2e` and `npm run smoke` (each under a timeout)
before declaring a change done. Test cases are documented per tool in `test/TEST_CASES.md`; add
rows there when you add cases. Every test that produces a .docx (inject_citations, `inject.js`)
should pass it through `expectValidDocx` from `test/helpers/docx-validate.ts` (structure, CSL schemas,
URIs, citeproc rendering with the vendored styles in `test/fixtures/csl/`). `scripts/smoke-stdio.mjs`
has its own lightweight structural docx check (plain .mjs, no citeproc): keep it in sync with the
validator when the field format changes. A manual Word + Zotero
plugin checklist for releases is in `test/WORD_CHECKLIST.md`.

The live suite only ever uses `ZOTERO_TEST_*` variables (see the LIVE section of `test/TEST_CASES.md`).
Against a personal library run it with `ZOTERO_LIVE_SAFE_MODE=1`. Assertions must be relative to what
the run creates (never absolute library counts), and every created key must carry the run markers so
the global teardown can remove it. After an interrupted run: `npm run test:live:cleanup -- [runId]`.

The agent smoke test (`.github/workflows/claude-agent-smoke.yml`, skill `.claude/skills/test-mcp-zotero`)
gets its environment from whoever starts the session, never from the agent: MCP server from
`test/live/agent/mcp.template.json`, built-in tools, permission mode `dontAsk` (in CI from
`.github/agents/agent-smoke.json`) and the hooks of
`.claude/agent-smoke/settings.json` (Bash allowlist, delete policy, audit log used as evidence by
`test/live/verify-claims.mjs`). Local runs use the same pieces: `test/live/agent/README.md`.

## CI workflows and agents

| Workflow | Trigger | What it does |
|---|---|---|
| `test.yml` | every PR (any base, so stacked PRs too), push to `main` | build, unit, smoke, e2e, packaging, `.mcpb` bundle (`mcpb validate`, `npm run bundle`, smoke of the unpacked bundle) on Node 22/24/26 |
| `live-tests.yml` | same-repo PRs, `main`, weekly (Friday), manual | `live-tests-run`: `npm run test:live` in environment `zotero-live`; always cleans up (`npm run test:live:cleanup`), uploads a scrubbed report; `live-tests` (required check) decides from it; weekly failures open/update one issue |
| `claude-agent-smoke.yml` | same-repo PRs by the owner or `github-actions[bot]` (the agent costs API credits: other people's changes only by hand, after review), manual (run it by hand on `main` after a merge) | prepare (no id-token: install without scripts, build, account checks, lock) → agent (only job with id-token) → verify (`test/live/verify-claims.mjs`) → `agent-smoke` (required check, decides from the others); `agent-smoke-cleanup` (always, also after a cancellation) cleans up and releases the lock |
| `deps-update.yml` | 1st of the month, manual | agent (no GitHub token, no install scripts, Context7 MCP for library docs, leaves a patch and optionally an issue text) → open-pr (no npm, no id-token: pushes `deps/<date>` and opens the PR labelled `dipendenze` with `GITHUB_TOKEN`, then starts test/live-tests/agent-smoke on the branch with `workflow_dispatch`) → merge-gate (no npm, main's copy of `scripts/deps-merge-gate.mjs`, waits for those checks on the exact SHA, `--match-head-commit`); issue (majors and postponed updates: opens or comments the open issue labelled `dipendenze`). Published agent text goes through `scripts/check-public-text.mjs` |
| `release.yml` | GitHub release published, manual | tests, npm publish, then `server.json` to the MCP Registry (`mcp-registry`: only job with id-token besides npm-publish, `mcp-publisher` pinned by version + sha256, GitHub OIDC login), skill zips, `.mcpb` (`mcpb-build` read-only, `mcpb-upload` the only write job: no checkout, no npm) (owner only) |

The agents authenticate to the Claude API with Anthropic Workload Identity Federation (environment
variables `ANTHROPIC_FEDERATION_RULE_ID`, `ANTHROPIC_ORGANIZATION_ID`, `ANTHROPIC_SERVICE_ACCOUNT_ID`,
`ANTHROPIC_WORKSPACE_ID` in `zotero-live` / `claude-deps`, job permission `id-token: write`); there is no
Anthropic API key secret. Zotero secrets stay in `zotero-live`.

The deps workflow uses only `GITHUB_TOKEN` on GitHub. Events caused by `GITHUB_TOKEN` start no
`pull_request`/`push` workflows, so open-pr starts the required ones with `workflow_dispatch` (the one
exception GitHub allows) on the dependency branch; their check runs attach to the PR head. The gate's
auto-merge produces a push to `main` that likewise triggers no workflows: every required check already
ran on the PR, and the weekly `live-tests.yml` run (Friday) covers `main`.

Required checks to set in the ruleset after the stack merges (names as GitHub shows them):
`test (node 22)`, `test (node 24)`, `test (node 26)`, `live-tests`, `agent-smoke`.

Live runs are serialized on the Zotero side by `test/live/lock.mjs` (lock collection
`mzt-lock <runId>`, wait up to 25 min locally and 70 min in CI, then "test account busy"; an agent smoke
run holds the account for up to about 80 min); workflow concurrency is per PR/ref,
so stacked PRs never cancel each other's required checks.

Every workflow installs with `npm ci --ignore-scripts`; Zotero secrets are set only on the steps that
need them, never at job level.

Path filters are a `changes` job, not `on.paths` (a workflow filtered by `on.paths` would leave a
required check pending). The required-name jobs (`live-tests`, `agent-smoke`) are never skipped, since
a skipped required check counts as passed: they run with `!cancelled()`, fail when `changes` or the
real jobs failed or timed out, and pass without testing only when nothing relevant changed (or for
fork PRs and Dependabot, which get no secrets; the agent smoke test also skips runs started by anyone
other than the owner or `github-actions[bot]`, and its notice names the condition). Fork PRs need the owner's
approval before any workflow runs (repository setting: approval for all external contributors). `test.yml` cancels a superseded run (cancelled,
not red); `live-tests.yml` and `claude-agent-smoke.yml` never cancel a running run (a cancel mid-suite left
data on the test account): a newer push queues.
Verified with a scratch workflow: a job that hits `timeout-minutes` concludes `cancelled`, and a dependent
job with `if: !cancelled()` still runs and sees `needs.<job>.result == 'cancelled'`, so a timeout turns
the verdict red instead of skipping it. Actions in the new workflows are pinned by
SHA; Dependabot updates them. On pull requests the agent job restores `.claude/` and
`CLAUDE.md` from the base branch, so a PR cannot change the instructions its own agent run follows.

The CI agents run with the Claude Agent SDK (`scripts/run-agent.mjs`, one JSON config per agent in
`.github/agents/`).

## Maintainer-side skills

Three project skills are run by a watcher outside GitHub Actions (headless Claude Code), never by CI:
`deps-major-upgrade` (majors from a `dipendenze` issue written by the deps workflow: upgrade and adapt the
code in a worktree; the watcher commits, pushes and opens the PR), `ci-failure-review` (failed checks on a
`dipendenze` PR: a public comment with the probable cause) and `triage-external` (issues and PRs by other
users: a private summary, untrusted input, no tools beyond reading the prepared text).

## Scheduled workflows

GitHub disables `schedule:` triggers after 60 days without repository activity on public repos.
If a scheduled workflow stopped running, re-enable it (owner action):

```sh
timeout 30 gh workflow list --all
timeout 30 gh workflow enable <workflow-file.yml>
```
