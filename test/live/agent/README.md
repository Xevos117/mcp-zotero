# Agent smoke test: how the session is started

The skill `.claude/skills/test-mcp-zotero` only describes the path the agent follows. Everything the agent
must not decide is set by whoever starts the session, the same way in CI and locally:

| What | Where | CI (`.github/workflows/claude-agent-smoke.yml`, after the live suite) | Locally |
|---|---|---|---|
| Run context, diff, targeted scenarios | `test/live/agent/prepare.mjs` (`context.targeted` from `.claude/skills/test-mcp-zotero/scenarios.json`) | `--mode ci` (dedicated test account only) | `--mode local`, `ZOTERO_LIVE_SAFE_MODE=1` on a personal library |
| MCP server | `test/live/agent/mcp.template.json` | rendered by `render-mcp.mjs` into `$RUNNER_TEMP` (key only in that file, mode 600) | passed as is: Claude Code expands `${VAR}` from your environment |
| Built-in tools | `--tools "Skill,Read,Edit,Write,Bash"` | same | same |
| Permissions | `--permission-mode dontAsk` + `--allowedTools` | same | same |
| Hooks | `.claude/agent-smoke/settings.json` | same (on PRs `.claude/` comes from the base branch) | same |
| Verdict | `test/live/verify-claims.mjs` | `agent-smoke` job | by hand, below |

The hooks: a Bash allowlist (only `node test/live/agent/make-docx.mjs …` and `node test/live/agent/inject.mjs …`
in their exact shape), deletions only of keys the run created (plus the non-existent `ZZZZZZZZ`/`YYYYYYYY`),
and an audit log of every Zotero call and Bash command in `agent-audit/audit.jsonl` (denials in
`agent-audit/denials.jsonl`), outside `agent-out/` where the agent can write. The audit hook numbers every call
(`call_no`, told to the agent after each call): the exploratory claims reference calls by that number, and
verify-claims checks that the numbers run 1..n without repeats or gaps.

## Local run

From the repository root, with the test account's key in your environment (never on the command line):

```sh
npm run build
export ZOTERO_TEST_API_KEY=… ZOTERO_TEST_USER_ID=… UNPAYWALL_EMAIL=…   # UNSAFE_OPERATIONS defaults to items
ZOTERO_LIVE_SAFE_MODE=1 node test/live/agent/prepare.mjs --mode local --base main
MCP_TIMEOUT=30000 MCP_TOOL_TIMEOUT=120000 timeout 2700 claude -p "Carica la skill test-mcp-zotero e segui il percorso. Diff in agent-out/diff.txt." \
  --model claude-sonnet-5-5 --max-turns 140 --max-budget-usd 2 \
  --mcp-config test/live/agent/mcp.template.json --strict-mcp-config \
  --setting-sources project --settings .claude/agent-smoke/settings.json \
  --tools "Skill,Read,Edit,Write,Bash" --permission-mode dontAsk \
  --allowedTools "Skill,mcp__zotero__*,Read(./agent-out/**),Read(./agent-render/**),Edit(./agent-out/**),Bash(node test/live/agent/make-docx.mjs *),Bash(node test/live/agent/inject.mjs *)" \
  --disallowedTools "WebFetch,WebSearch" \
  --output-format stream-json --verbose < /dev/null > agent-audit/transcript.jsonl
```

Drop `ZOTERO_LIVE_SAFE_MODE=1` only on a disposable test library (with the `__mzt_disposable__` collection).
Safe mode allows `UNSAFE_OPERATIONS=items` at most and never deletes collections or writes to groups.

Never commit `agent-out/`, `agent-audit/` or the transcript: they hold library content (titles, keys,
collection names, your user id). They are gitignored and `test.yml` fails if any is tracked.

Then verify and clean up:

```sh
node test/live/verify-claims.mjs agent-out --audit agent-audit/audit.jsonl --transcript agent-audit/transcript.jsonl
ZOTERO_LIVE_SAFE_MODE=1 npm run test:live:cleanup -- "$(node -p 'require("./agent-out/context.json").run_id')"
```

Visual review (step 5b of the skill): it needs the pages of the word-render job in `agent-render/` (CI downloads
them). Locally, render them first (Zotero 10 + `wordcraft-cli`, see `test/word-proxy/README.md`):
`XVFB=Xvfb test/word-proxy/ci.sh <zotero-dir> <wordcraft-cli> /tmp/wp && node test/word-proxy/render.mjs /tmp/wp
<wordcraft-cli> agent-render`, then add `--render agent-render` to the verify-claims command. Without
`agent-render/` the agent skips step 5b and verify-claims runs without `--render`.

Local run with `claude-sonnet-5-5`: see the "Collaudo locale" paragraph of the agent smoke section in
`test/TEST_CASES.md`.
