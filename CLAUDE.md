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

## Conventions

- Commit messages, PR titles/descriptions and `test/TEST_CASES.md` are written in **Italian**.
  Code comments and identifiers are in English. Keep diffs focused; match the surrounding style.
- Never edit `build/` by hand; it is gitignored and produced by `npm run build`.
- Tool errors go through `formatErrorResponse` (`isError: true`); empty results through
  `formatEmptyResult` (no `isError`). Deletions are gated by `UNSAFE_OPERATIONS` (`none|items|all`).
- `.claude/` is ignored except `.claude/skills/` (versioned project skills). `.npmignore` keeps
  `.claude/` and `CLAUDE.md` out of the npm package; `package.json` `files` is `["build"]`.

## Tests

| Command | What runs | Network |
|---|---|---|
| `npm test` | unit + per-tool suites: `src/**/*.test.ts`, `test/**/*.test.ts` (excluding `test/e2e`) | none (fetch faked) |
| `npm run test:e2e` | builds, then `test/e2e/**` against `build/server.js` over stdio | none (fetch redirected to a local fake) |
| `npm run smoke` | `scripts/smoke-stdio.mjs`: built server, user + group library, stubbed fetch | none |
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
`test/live/agent/mcp.template.json`, `--tools`, `--permission-mode dontAsk` and the hooks of
`.claude/agent-smoke/settings.json` (Bash allowlist, delete policy, audit log used as evidence by
`test/live/verify-claims.mjs`). Local runs use the same pieces: `test/live/agent/README.md`.

## CI workflows and agents

| Workflow | Trigger | What it does |
|---|---|---|
| `test.yml` | every PR (any base, so stacked PRs too), push to `main` | build, unit, smoke, e2e, packaging on Node 22/24/26 |
| `live-tests.yml` | same-repo PRs, `main`, nightly, manual | `npm run test:live` in environment `zotero-live`; always cleans up (`npm run test:live:cleanup`), uploads a scrubbed report; nightly failures open/update one issue |
| `claude-agent-smoke.yml` | same-repo PRs by the owner or a bot, `main`, manual | three jobs: prepare (no id-token: install without scripts, build, account checks, lock) → agent (only job with id-token) → `agent-smoke` (verdict by `test/live/verify-claims.mjs`, cleanup, lock release) |
| `deps-update.yml` | 1st of the month, manual | three jobs: agent (read-only token, no install scripts, leaves a patch) → open-pr (no npm, Claude App token, opens the PR) → merge-gate (no npm, main's copy of `scripts/deps-merge-gate.mjs`, waits for test/live/agent-smoke on the exact SHA, `--match-head-commit`) |
| `release.yml` | GitHub release published, manual | tests, npm publish, skill zips (owner only) |

The agents authenticate to the Claude API with Anthropic Workload Identity Federation (environment
variables `ANTHROPIC_FEDERATION_RULE_ID`, `ANTHROPIC_ORGANIZATION_ID`, `ANTHROPIC_SERVICE_ACCOUNT_ID`,
`ANTHROPIC_WORKSPACE_ID` in `zotero-live` / `claude-deps`, job permission `id-token: write`); there is no
Anthropic API key secret. Zotero secrets stay in `zotero-live`.

The deps gate enables auto-merge with `GITHUB_TOKEN`: the resulting squash-merge push to `main`
triggers no workflows (events caused by `GITHUB_TOKEN` never do). That is acceptable because every
required check already ran on the PR; the nightly `live-tests.yml` run then covers `main`.

Live runs are serialized on the Zotero side by `test/live/lock.mjs` (lock collection
`mzt-lock <runId>`, wait up to 25 min, then "test account busy"); workflow concurrency is per PR/ref,
so stacked PRs never cancel each other's required checks.

Every workflow installs with `npm ci --ignore-scripts`; Zotero secrets are set only on the steps that
need them, never at job level.

Path filters are job-level `if` conditions (a skipped job satisfies a required check; a workflow
filtered by `on.paths` would leave the check pending). Actions in the new workflows are pinned by
SHA; Dependabot updates them. On pull requests claude-code-action restores `.claude/` and
`CLAUDE.md` from the base branch, so a PR cannot change the instructions its own agent run follows.

## Scheduled workflows

GitHub disables `schedule:` triggers after 60 days without repository activity on public repos.
If a scheduled workflow stopped running, re-enable it (owner action):

```sh
timeout 30 gh workflow list --all
timeout 30 gh workflow enable <workflow-file.yml>
```
