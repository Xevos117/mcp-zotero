---
name: deps-update
description: Monthly dependency update for mcp-zotero — minor and patch updates only, full build/test/e2e/smoke, fixes for what breaks, CHANGELOG entry, one pull request in Italian; majors are only listed. Use when the deps-update workflow says to load this skill, or when asked to update the dependencies.
---

# deps-update — monthly dependency update

You update the npm dependencies of this repository and open **one** pull request. A deterministic
step after you (`scripts/deps-merge-gate.mjs`) decides whether the PR can be auto-merged: only if it
touches nothing but `package.json`, `package-lock.json` and `CHANGELOG.md` and every version change is
a semver patch. Anything else stays for the owner. You never decide that, and you never merge.

## Rules

- **Never** merge a PR, publish to npm, create a release or tag, push to `main`, force-push, or edit
  anything under `.github/`. Do not bump the package `version`.
- **Minor and patch only.** Majors are listed in the PR description, never installed.
- `npm install`/`npm update`/`npm ci` always with `--ignore-scripts` (the native binaries of
  TypeScript 7 and rolldown/vitest come as optionalDependencies and need no install scripts).
- Every command runs through the Bash tool, which bounds it; give long commands (`npm ci`, tests) a
  Bash timeout of at most 10 minutes. A command that hits its bound is a failure to report.
- Commit messages, the PR title and description are in **Italian**. Code comments stay English.
- If there is nothing to update, stop: no branch, no commit, no PR.

## Steps

1. **State.** `git status --porcelain` must be empty and the current branch must be `main`.
   Note the month: `git log -1 --format=%cd --date=format:%Y-%m`. Branch name: `deps/<YYYY-MM>`.
2. **What is outdated.** `npm outdated --json` (exit code 1 is normal when something is outdated).
   For each package compare `current`, `wanted`, `latest`:
   - same major as `current` and newer → update;
   - only a newer major → list it under "Major non applicate" with current and latest version.
   If nothing is updatable, stop here.
3. **Update.** `git switch -c deps/<YYYY-MM>`, then `npm update --save --ignore-scripts` (respects the
   `^` ranges and moves them to the new versions). If a wanted minor is still missing, install it
   explicitly: `npm install --save[-dev] --ignore-scripts <name>@^<version>`.
4. **Verify from scratch.** `npm ci --ignore-scripts`, then `npm run build`, `npm test`,
   `npm run test:e2e`, `npm run smoke`. All must pass.
5. **Fix what breaks.** If a minor update breaks the build or the tests, fix the code with the
   smallest change (or revert that single package to its previous version and list it under
   "Rinviati" with the reason). Re-run step 4 after every fix. Code fixes are allowed, but they mean
   the PR will not be auto-merged: say so in the description.
6. **CHANGELOG.** Under `## [Unreleased]` add (or extend) a `### Dipendenze` section: one line per
   direct dependency, `name` old → new, plus a short note for any code fix.
7. **Commit and push.** `git add package.json package-lock.json CHANGELOG.md` (plus any fixed file),
   commit in Italian (`Dipendenze: aggiornamenti minor e patch (<YYYY-MM>)`), then
   `git push origin deps/<YYYY-MM>`.
8. **Pull request.** `gh pr create --base main --head deps/<YYYY-MM> --title "Dipendenze: aggiornamenti minor e patch (<YYYY-MM>)" --body "<body>"`
   with, in Italian:
   - a table of the direct dependencies updated (old → new, patch or minor);
   - "Major non applicate": name, current, latest, and one line on what the upgrade would involve;
   - "Rinviati" (if any) with the reason;
   - the results of build, test, e2e and smoke (counts);
   - whether code was changed (then: "da rivedere a mano, niente merge automatico").
9. Finish with a short summary (PR link, updated packages, majors listed). Then stop.
