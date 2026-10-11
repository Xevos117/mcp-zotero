---
name: deps-update
description: Monthly dependency update for mcp-zotero — minor and patch updates only, full build/test/e2e/smoke, fixes for what breaks, CHANGELOG entry, one pull request in Italian; majors are only listed. Use when the deps-update workflow says to load this skill, or when asked to update the dependencies.
---

# deps-update — monthly dependency update

You update the npm dependencies of this repository and leave the result in the working tree, plus a
PR title and description in `agent-out/deps-pr.md`. You do not commit, push or open the PR: a later
job without npm takes only `package.json`, `package-lock.json` and `CHANGELOG.md` as a patch, opens the
PR, and a deterministic gate (`scripts/deps-merge-gate.mjs`) decides whether it can be auto-merged (only
patch bumps from the npm registry, released at least 7 days ago, with every check green). You never
decide that, and you never merge.

## Rules

- **Never** commit, push, open or merge a PR, publish to npm, create a release or tag. Do not bump the
  package `version`. Change only `package.json`, `package-lock.json`, `CHANGELOG.md` and
  `agent-out/deps-pr.md`: **never edit source code, tests or workflows** (anything else makes the job fail
  without a PR).
- **Minor and patch only.** Majors are listed in the PR description, never installed.
- `npm install`/`npm update`/`npm ci` always with `--ignore-scripts` (also enforced by
  `NPM_CONFIG_IGNORE_SCRIPTS=true`; the native binaries of TypeScript 7 and rolldown/vitest come as
  optionalDependencies and need no install scripts).
- Every command runs through the Bash tool, which bounds it; give long commands (`npm ci`, tests) a
  Bash timeout of at most 10 minutes. A command that hits its bound is a failure to report.
- Commit messages, the PR title and description are in **Italian**. Code comments stay English.
- If there is nothing to update, stop without changing anything and without writing `agent-out/deps-pr.md`.

## Steps

1. **State.** `git status --porcelain` must be empty. Note the month for the title:
   `git log -1 --format=%cd --date=format:%Y-%m`.
2. **What is outdated.** `npm outdated --json` (exit code 1 is normal when something is outdated).
   For each package compare `current`, `wanted`, `latest`:
   - same major as `current` and newer → update;
   - only a newer major → list it under "Major non applicate" with current and latest version.
   If nothing is updatable, stop here.
3. **Update.** `npm update --save --ignore-scripts` (respects the
   `^` ranges and moves them to the new versions). If a wanted minor is still missing, install it
   explicitly: `npm install --save[-dev] --ignore-scripts <name>@^<version>`.
4. **Verify from scratch.** `npm ci --ignore-scripts`, then `npm run build`, `npm test`,
   `npm run test:e2e`, `npm run smoke`. All must pass.
5. **What breaks is postponed, not fixed.** If an update breaks the build or the tests, put that single
   package back to its previous version (`npm install --save[-dev] --ignore-scripts <name>@<old>`) and list
   it under "Rinviati" with the error in one line. Re-run step 4 after every revert. Code fixes are for
   a human PR, not for this job.
6. **CHANGELOG.** Under `## [Unreleased]` add (or extend) a `### Dipendenze` section: one line per
   direct dependency, `name` old → new, plus a short note for any code fix.
7. **PR text.** Write `agent-out/deps-pr.md` (Write tool): the **first line** is the title,
   `Dipendenze: aggiornamenti minor e patch (<YYYY-MM>)`; the rest is the description, in Italian:
   - a table of the direct dependencies updated (old → new, patch or minor);
   - "Major non applicate": name, current, latest, and one line on what the upgrade would involve;
   - "Rinviati" (if any) with the reason;
   - the results of build, test, e2e and smoke (counts).
8. Leave the changes uncommitted in the working tree.
9. Finish with a short summary (updated packages, majors listed, postponed). Then stop.
