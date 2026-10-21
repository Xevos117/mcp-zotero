# MCP Zotero

> **Note:** This is an unofficial community project and is not affiliated with, endorsed by, or supported by the Zotero team or the Corporation for Digital Scholarship. "Zotero" is a registered trademark of the Corporation for Digital Scholarship.

A Model Context Protocol server for Zotero integration. It gives any LLM full access to your Zotero library: search, organize, add papers by DOI, import PDFs, read full-text content, and inject live citations into Word documents.

> Originally based on [mcp-zotero](https://github.com/kaliaboi/mcp-zotero) by Abhishek Kalia.
> This project has since been extensively rewritten with a new architecture, 15 tools (up from 5), citation injection, PDF management, and Claude skill support.

## How it works

The server is designed to be **usable by any LLM without external documentation**. On connection, it sends workflow instructions via the MCP `instructions` field, and each tool description includes cross-references and usage guidance. An LLM that has never seen this server before can discover the full workflow — from adding papers to producing a cited Word document — directly from the tool listing.

For advanced use cases (PDF upload policy, citation style guidance, source transparency), a **Claude skill** is included for Claude.ai Projects. But the skill is optional: the MCP server is fully self-documenting.

## Local vs Remote LLMs

| Scenario | MCP server | Skill needed? |
|---|---|---|
| LLM with filesystem access (Claude Code, LM Studio, etc.) | All 15 tools | No |
| LLM without filesystem access (Claude.ai Projects, Claude Desktop) | API tools (search, add, metadata) | Yes, for citation injection |

LLMs with filesystem access can use all tools directly, including `inject_citations` which reads and writes `.docx` files on disk.

LLMs without filesystem access — including Claude Desktop, which connects to MCP but cannot generate files locally — can use the included **Claude skill** (`skills/zotero-skill-mcp-integrations/`), which runs citation injection entirely inside a sandbox. MCP tools handle all Zotero API operations; the skill handles document assembly.

### Claude Skill Setup (for Claude.ai Projects and Claude Desktop)

1. Download the skill `.zip` from the latest [GitHub Release](https://github.com/Xevos117/mcp-zotero/releases)
2. Extract it and upload the folder to your Claude.ai Project as a skill
3. The skill enables citation injection directly inside the sandbox, without requiring local filesystem access

## Setup

Requires **Node.js 22 or newer**.

The server is listed in the official [MCP Registry](https://registry.modelcontextprotocol.io) as
`io.github.Xevos117/mcp-zotero` (starting with the first release after 2.0.2), so registry-aware clients can find and install it from
there; the configuration below works with any MCP client.

1. Get your Zotero credentials:

   ```bash
   # Create an API key at https://www.zotero.org/settings/keys
   # (enable library read/write + file access)
   # Then retrieve your user ID:
   curl -H "Zotero-API-Key: YOUR_API_KEY" https://api.zotero.org/keys/current
   ```

2. Set environment variables:

   ```bash
   export ZOTERO_API_KEY="your-api-key"
   export ZOTERO_USER_ID="user-id-from-curl"
   export UNPAYWALL_EMAIL="your@email.edu"   # Optional: enables OA PDF lookup via Unpaywall
   export UNSAFE_OPERATIONS="none"           # Optional: "none" | "items" | "all" (see below)
   ```

### Targeting a group library

By default the server targets your personal Zotero library (`/users/<ZOTERO_USER_ID>/...`).
To target a group library instead, set two additional environment variables:

| Variable | Values | Required? | Default |
|---|---|---|---|
| `ZOTERO_LIBRARY_TYPE` | `user` \| `group` | No | `user` |
| `ZOTERO_LIBRARY_ID` | numeric library ID | Yes when type=`group`; otherwise falls back to `ZOTERO_USER_ID` | — |

Example for a group library:

```
ZOTERO_API_KEY=...
ZOTERO_USER_ID=12345               # optional for groups: used by get_user_id and per-call library_type="user"
ZOTERO_LIBRARY_TYPE=group
ZOTERO_LIBRARY_ID=6178978          # the group ID
```

The API key in `ZOTERO_API_KEY` must have access to the target group library — generate or scope keys at https://www.zotero.org/settings/keys.

The server refuses to start if `ZOTERO_LIBRARY_TYPE=group` is set without `ZOTERO_LIBRARY_ID`, or if a library ID is not numeric.


### Per-call library override

Every tool accepts two optional args that override the env defaults for that single call:

- `library_type` — `"user"` or `"group"`
- `library_id` — numeric library ID

Resolution order: per-call arg > env var > implicit default (`user`, `ZOTERO_USER_ID`). `library_id` must be numeric. Overriding `library_type` to `group` on a server configured for a user library requires `library_id`; overriding to `user` on a group server without `library_id` uses `ZOTERO_USER_ID`.

Note that per-call overrides let the LLM reach any library the API key can access. Scope the key to the libraries you want exposed; deletions remain gated by `UNSAFE_OPERATIONS`.

This lets a single MCP instance target multiple libraries (e.g., a staging group and a final-output group) without restarting:

```jsonc
// First call targets the staging group
{
  "tool": "add_items",
  "args": {
    "items": [...],
    "library_type": "group",
    "library_id": "5597114"
  }
}

// Second call targets DART-output (different group)
{
  "tool": "add_items",
  "args": {
    "items": [...],
    "library_type": "group",
    "library_id": "6178978"
  }
}
```

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `ZOTERO_API_KEY` | Yes | API key for Zotero Web API v3. Create one at [zotero.org/settings/keys](https://www.zotero.org/settings/keys) with library read/write and file access permissions. |
| `ZOTERO_USER_ID` | Yes | Your Zotero numeric user ID. Retrieve it with `curl -H "Zotero-API-Key: KEY" https://api.zotero.org/keys/current`. |
| `UNPAYWALL_EMAIL` | No | Email for Unpaywall API requests ([rate-limit policy](https://unpaywall.org/products/api)). Enables OA PDF lookup in `add_items_by_doi` and `find_and_attach_pdfs`. If not set, OA PDF features are silently skipped. |
| `UNSAFE_OPERATIONS` | No | Controls destructive operations (deletion). See [Unsafe Operations](#unsafe-operations) below. Default: `none` (all deletions blocked). |

### Unsafe Operations

By default, the MCP server **does not allow any deletion**. This is a safety measure to prevent an LLM from accidentally deleting items or collections from your library.

To enable deletion, set the `UNSAFE_OPERATIONS` environment variable to one of the following values:

| Value | `delete_items` | `delete_collection` | Use case |
|---|---|---|---|
| `none` (default) | Blocked | Blocked | Safe mode — no deletions possible |
| `items` | **Allowed** | Blocked | Allow deleting items but protect collection structure |
| `all` | **Allowed** | **Allowed** | Full access — items and collections can be deleted |

**Important notes:**

- If `UNSAFE_OPERATIONS` is not set, empty, or set to an unrecognized value, it defaults to `none`.
- The value is **case-insensitive** (e.g. `ALL`, `Items`, `NONE` all work).
- `delete_items` deletes items **permanently**: the Zotero Web API multi-item DELETE does not move them to the Zotero trash, so they cannot be restored from the desktop client.
- `delete_collection` removes the collection (folder) only — items inside it are **not** deleted and remain in your library.
- The `all` value includes both item and collection deletion because managing collections inherently requires item-level access.

**Configuration example:**

```json
{
  "mcpServers": {
    "zotero": {
      "command": "npx",
      "args": ["-y", "@xevos117/mcp-zotero"],
      "env": {
        "ZOTERO_API_KEY": "YOUR_API_KEY",
        "ZOTERO_USER_ID": "YOUR_USER_ID",
        "UNSAFE_OPERATIONS": "items"
      }
    }
  }
}
```

## Integration with Claude Desktop

### Install as a Claude Desktop extension (one click)

1. Download `mcp-zotero.mcpb` from the [latest release](https://github.com/Xevos117/mcp-zotero/releases/latest)
   (available from the first release after 2.0.2).
2. Open the file with Claude Desktop (macOS or Windows; e.g. double-click it) and confirm in the installation dialog.
   The bundle itself is not platform-specific (`manifest.json` lists macOS, Windows and Linux, and CI runs it on
   Linux), so other MCPB-compatible clients can install it too.
3. Fill in your **Zotero API key** and **Zotero user ID** (see [Setup](#setup)). Optional settings: library type and
   group ID (for a group library), the email for Unpaywall (open-access PDF lookup) and which deletions are allowed
   (default: none, see [Unsafe Operations](#unsafe-operations)).

The extension bundles the server and all its dependencies, so no npm install is needed. It needs Node.js 22 or newer
(`compatibility.runtimes.node` in the manifest): according to the MCPB documentation, Claude Desktop runs Node.js
extensions with the runtime that ships with the app. The API key is declared as a sensitive setting (masked
input, stored securely by the client). Deletions stay disabled unless you change *Deletions allowed* in the
extension settings.

The extension contains only the MCP server: the Claude skills in [`skills/`](skills/) (citation injection inside
the sandbox, scientific writing) are installed separately from their `.zip` files in the same release, as described
in [Claude Skill Setup](#claude-skill-setup-for-claudeai-projects-and-claude-desktop).

### Manual configuration (any MCP client)

Add to your Claude Desktop configuration (or the equivalent file of another MCP client):

```json
{
  "mcpServers": {
    "zotero": {
      "command": "npx",
      "args": ["-y", "@xevos117/mcp-zotero"],
      "env": {
        "ZOTERO_API_KEY": "YOUR_API_KEY",
        "ZOTERO_USER_ID": "YOUR_USER_ID",
        "UNPAYWALL_EMAIL": "YOUR_EMAIL"
      }
    }
  }
}
```

## Integration with Claude Code

```bash
claude mcp add zotero -e ZOTERO_API_KEY=YOUR_API_KEY -e ZOTERO_USER_ID=YOUR_USER_ID -- npx -y @xevos117/mcp-zotero
```

Add `-e UNPAYWALL_EMAIL=...` or `-e UNSAFE_OPERATIONS=items` as needed, and `--scope user` to make the server
available in every project (the default `local` scope covers only the current project). From a clone of this repository,
`npx tsx src/server.ts` runs the server from source instead (see [Development](#development)).

## Available Tools

### Library browsing

| Tool | Description |
|---|---|
| `get_collections` | List all collections (folders) with keys, names, and parent relationships |
| `get_collection_items` | Get items in a specific collection with keys, titles, authors, dates |
| `search_library` | Search by query, or list items sorted by field (date, title, etc.) |
| `get_items_details` | Batch metadata retrieval for multiple items — returns all type-specific fields (bookTitle, proceedingsTitle, university, etc.), the `authors` string and the structured `creators`; keys not in the library are listed in `not_found` |
| `get_item_fulltext` | Get full-text content of a PDF attachment via Zotero's fulltext index |

### Adding content

| Tool | Description |
|---|---|
| `add_items_by_doi` | Add papers by DOI with automatic metadata resolution. Auto-attaches OA PDFs via Unpaywall |
| `add_items` | Add items with direct metadata — supports all 37 Zotero item types (books, theses, reports, etc.), batch-capable |
| `create_collection` | Create a new collection, optionally nested under a parent |
| `import_pdf_to_zotero` | Download a PDF from URL, upload to Zotero storage, auto-index full text |
| `find_and_attach_pdfs` | Batch OA PDF lookup and auto-attach via Unpaywall (by item keys or collection) |
| `add_linked_url_attachment` | Attach a URL to an existing item or create a standalone link |

### Deleting content

| Tool | Description |
|---|---|
| `delete_items` | Permanently delete up to 50 items per call (not moved to the Zotero trash). Requires `UNSAFE_OPERATIONS=items` or `all` |
| `delete_collection` | Delete a collection (folder). Items inside are kept. Requires `UNSAFE_OPERATIONS=all` |

### Citation & documents

| Tool | Description |
|---|---|
| `inject_citations` | Inject live Zotero citations into a Word document. Supports APA, IEEE, Vancouver, Harvard, Chicago. Output is saved in the same folder as the input file with a `_cited` suffix (e.g. `paper.docx` → `paper_cited.docx`) |
| `get_user_id` | Returns the configured Zotero user ID |

## Development

```bash
npm install
npm run build          # Compile TypeScript
npm test               # Unit and per-tool tests (vitest, fetch faked, ~1000 tests)
npm run test:e2e       # Built server over stdio against a local fake Zotero API
npm run smoke          # Quick stdio smoke test of the built server (user + group library)
npm run bundle         # Claude Desktop extension: dist/mcp-zotero.mcpb (production dependencies only)
npm run smoke -- --bundle dist/mcp-zotero.mcpb   # smoke test of the unpacked bundle, started from its manifest
npx tsx src/server.ts  # Run directly without building
```

### Testing

| Layer | Command | Runs on | What it covers |
|---|---|---|---|
| Unit / per tool | `npm test` | every PR (Node 22, 24, 26) | every tool through a real MCP client, Zotero faked at the `fetch` level; produced `.docx` files are validated against the official CSL schemas and rendered with citeproc-js ([test/helpers/docx-validate.ts](test/helpers/docx-validate.ts)) |
| E2E + smoke | `npm run test:e2e`, `npm run smoke` | every PR | the compiled server over stdio, user and group libraries |
| Live | `npm run test:live` ([workflow](.github/workflows/claude-agent-smoke.yml), shared with the agent smoke test) | PRs from this repository, `main`, weekly (Friday), manual runs | the real Zotero Web API on a dedicated test account ([test/live](test/live)); skipped unless `ZOTERO_TEST_API_KEY` is set |
| Agent smoke | [workflow](.github/workflows/claude-agent-smoke.yml), after the live suite passed | PRs from this repository, manual runs (e.g. on `main` after a merge) | a Claude Code agent uses the server like a user, following the versioned skill [`.claude/skills/test-mcp-zotero`](.claude/skills/test-mcp-zotero/SKILL.md): `inject_citations` ⇄ `inject.js` parity in every style, fixed edge cases and up to 5 exploratory scenarios on what the PR changes. The workflow sets up the MCP server, the tool set and guard hooks (Bash allowlist, delete policy, audit log); local runs use the same pieces ([test/live/agent/README.md](test/live/agent/README.md)). The verdict comes from [test/live/verify-claims.mjs](test/live/verify-claims.mjs), not from the agent; each run writes a Job Summary (verdict, scenarios, exploratory findings, friction, turns/cost/duration) and keeps one comment on the PR up to date, both scrubbed of anything that identifies the test account |
| Word | manual | every release | [test/WORD_CHECKLIST.md](test/WORD_CHECKLIST.md): open an injected document in Word with the Zotero plugin |

Every test case is listed in [test/TEST_CASES.md](test/TEST_CASES.md).

**Live tests locally** use only `ZOTERO_TEST_*` variables, never your `ZOTERO_API_KEY`:

```bash
ZOTERO_TEST_API_KEY=... ZOTERO_TEST_USER_ID=... UNPAYWALL_EMAIL=you@example.org npm run test:live
```

Against a personal library add `ZOTERO_LIVE_SAFE_MODE=1`: the suite only creates items and collections
named `mzt-<runId>…` and tagged `mzt-run:<runId>`, deletes only those, and skips collection deletion and
group writes. A dedicated test account is marked by a collection named `__mzt_disposable__`.

**Dependencies** are updated monthly by a Claude Code agent ([workflow](.github/workflows/deps-update.yml),
skill [`.claude/skills/deps-update`](.claude/skills/deps-update/SKILL.md)); patch-only PRs are auto-merged after
all required checks pass, anything else waits for review. GitHub Actions versions are updated by Dependabot.

### CI setup (repository owner)

| Environment | Secrets | Variables |
|---|---|---|
| `zotero-live` (live tests, agent smoke) | `ZOTERO_TEST_API_KEY`, `ZOTERO_TEST_USER_ID`, `ZOTERO_TEST_USERNAME`, `ZOTERO_TEST_GROUP_ID` (optional), `UNPAYWALL_EMAIL` | `ANTHROPIC_FEDERATION_RULE_ID`, `ANTHROPIC_ORGANIZATION_ID`, `ANTHROPIC_SERVICE_ACCOUNT_ID`, `ANTHROPIC_WORKSPACE_ID` |
| `claude-deps` (dependency agent) | — | the same four `ANTHROPIC_*` variables (the federation rule may differ) |

The agents authenticate to the Claude API with Anthropic Workload Identity Federation (GitHub OIDC, no
API key). Recommended: one federation rule per environment, as narrow as possible:

| Rule for | subject (exact, no `*`) | claims (exact string pairs) | condition (CEL) |
|---|---|---|---|
| `zotero-live` | `repo:Xevos117/mcp-zotero:environment:zotero-live` | `repository_id: 1152178663`, `repository_owner_id: 86290818` | `claims.job_workflow_ref.startsWith("Xevos117/mcp-zotero/.github/workflows/claude-agent-smoke.yml@")` (PR runs use the PR ref) |
| `claude-deps` | `repo:Xevos117/mcp-zotero:environment:claude-deps` | `repository_id: 1152178663`, `repository_owner_id: 86290818`, `job_workflow_ref: Xevos117/mcp-zotero/.github/workflows/deps-update.yml@refs/heads/main` | — |

Claims are exact-match string pairs (only `subject_prefix` supports a trailing `*`), so a prefix such as
"this workflow on any ref" must be written as a CEL `condition`, as above; an exact `job_workflow_ref`
(claude-deps, main only) can be a plain claim.

Audience `https://api.anthropic.com`. The subject is an exact match unless it ends with `*`; jobs that use
an environment get the OIDC subject `repo:Xevos117/mcp-zotero:environment:<environment>`, so a rule
written for a branch or PR subject never matches. Numeric ids (not names) keep a renamed or re-created
repository/account from matching.

Trade-off for `zotero-live`: the "any ref" condition is needed for the agent smoke test to run on pull
requests, but it also accepts a modified copy of that workflow file pushed to any branch of this repository
(only people with write access can push). Pinning it to the exact claim
`job_workflow_ref: Xevos117/mcp-zotero/.github/workflows/claude-agent-smoke.yml@refs/heads/main` closes that
gap but disables the agent smoke test on PRs (it would then run only on manual runs from `main`).

Other owner settings:

- The Zotero test account needs a collection named `__mzt_disposable__`.
- Repository settings: "Allow auto-merge", and "Allow GitHub Actions to create and approve pull requests"
  (the dependency workflow opens its PR with `GITHUB_TOKEN`). Keep the ruleset at **0 required approvals**:
  auto-merge of the dependency PR relies on it, and it is also what makes the second setting acceptable. That
  setting is a conscious trade-off: it lets workflows open PRs (needed) and approve them (not used by any
  workflow here); if approvals are ever required, it would let a workflow approve its own PR, so revisit it
  together with any approval requirement.
- No GitHub App is used by any workflow (the agents authenticate to Anthropic with Workload Identity
  Federation and use only `GITHUB_TOKEN` on GitHub, read-only for the agents). If the Claude GitHub App is
  installed on this repository, uninstall it.
- Set a monthly spend limit on the Anthropic workspace used by the federation rules: it is the real cap on
  agent costs.
- Residual risk: the agent smoke job that holds the OIDC token also runs the MCP server built from the PR's
  code (that is what it tests). It runs only for same-repository PRs by the owner or a bot, the token is
  bound to the `zotero-live` environment and the workspace spend limit caps any misuse.
- Required checks after the stack merges: `test (node 22)`, `test (node 24)`, `test (node 26)`,
  `live-tests`, `agent-smoke`.

### Releasing

1. Update `CHANGELOG.md` (move `Unreleased` to the new version) and the version in `package.json`, in
   `server.json` (`version` and `packages[0].version`) and in `manifest.json` (`npm test` fails if they differ).
2. Make sure CI, live tests and the agent smoke test are green on `main`.
3. Run the manual [Word checklist](test/WORD_CHECKLIST.md) on a document injected by the release candidate
   and record the results in its log.
4. Before the first release that ships the Claude Desktop extension (and whenever `manifest.json` or the Node.js
   requirement changes): build it with `npm run bundle`, install `dist/mcp-zotero.mcpb` once in a real Claude
   Desktop (macOS or Windows), fill in a test key and user ID, and check that the 15 tools appear and
   `get_collections` answers.
5. Publish the GitHub release: the [release workflow](.github/workflows/release.yml) runs the tests, publishes
   to npm, publishes `server.json` to the [MCP Registry](https://registry.modelcontextprotocol.io) and attaches
   the skill zips and the Claude Desktop extension (`mcp-zotero.mcpb`). The release tag must be the version
   (e.g. `2.0.3`): the registry and bundle jobs check out the tag and fail if `package.json` differs.
6. If only the `mcp-registry` job fails, use **Re-run failed jobs** on the run: **Re-run all jobs** stops at the
   npm publish (the version already exists) and so never reaches the registry.

### Debug with MCP Inspector

```bash
npx @modelcontextprotocol/inspector npx tsx src/server.ts
```

## License

MIT - see [LICENSE](LICENSE) for details.
