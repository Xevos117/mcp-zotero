#!/usr/bin/env node
// Auto-merge gate for the monthly dependency PR, decided by code and not by the agent:
// the PR may be auto-merged only if it touches package.json, package-lock.json and CHANGELOG.md
// and every package version that changes in the lockfile is a semver patch bump (same major and
// minor). Added or removed packages, range edits that widen beyond patch, or any other file → the PR
// stays for the owner.
// Usage: node scripts/deps-merge-gate.mjs <base-ref> <head-ref>  (prints a JSON verdict, exit 0 = mergeable,
// 1 = leave for the owner, 2 = error)
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const ALLOWED_FILES = new Set(["package.json", "package-lock.json", "CHANGELOG.md"]);

export function parseVersion(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(String(v ?? ""));
  return m ? { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] ?? null } : null;
}

/** True if `to` is a strictly newer patch release of `from` (no prereleases). */
export function isPatchBump(from, to) {
  const a = parseVersion(from);
  const b = parseVersion(to);
  if (!a || !b || a.pre || b.pre) return false;
  return a.major === b.major && a.minor === b.minor && b.patch > a.patch;
}

/** Range in package.json: only "^x.y.z" / "~x.y.z" / "x.y.z" whose base version moves by a patch (or not at all). */
function rangeChangeIsPatch(from, to) {
  const strip = (r) => /^([\^~]?)(\d+\.\d+\.\d+)$/.exec(String(r ?? ""));
  const a = strip(from);
  const b = strip(to);
  if (!a || !b || a[1] !== b[1]) return false;
  return a[2] === b[2] || isPatchBump(a[2], b[2]);
}

/**
 * @param {{ changedFiles: string[], basePkg: object, headPkg: object, baseLock: object, headLock: object }} input
 * @returns {{ mergeable: boolean, reasons: string[], bumps: Array<{ name: string, from: string, to: string }> }}
 */
export function evaluateGate({ changedFiles, basePkg, headPkg, baseLock, headLock }) {
  const reasons = [];
  const bumps = [];
  const other = changedFiles.filter((f) => !ALLOWED_FILES.has(f));
  if (other.length) reasons.push(`files outside package.json/package-lock.json/CHANGELOG.md: ${other.join(", ")}`);
  if (!changedFiles.includes("package-lock.json")) reasons.push("package-lock.json unchanged: nothing to merge automatically");

  for (const field of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
    const a = basePkg[field] ?? {};
    const b = headPkg[field] ?? {};
    for (const name of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (!(name in a)) reasons.push(`${field}: ${name} added`);
      else if (!(name in b)) reasons.push(`${field}: ${name} removed`);
      else if (a[name] !== b[name] && !rangeChangeIsPatch(a[name], b[name])) reasons.push(`${field}: ${name} ${a[name]} → ${b[name]} is not a patch range change`);
    }
  }
  const strip = (pkg) => {
    const { dependencies, devDependencies, optionalDependencies, peerDependencies, ...rest } = pkg;
    return JSON.stringify(rest);
  };
  if (strip(basePkg) !== strip(headPkg)) reasons.push("package.json changed outside the dependency fields (e.g. version or scripts)");

  const pa = baseLock.packages ?? {};
  const pb = headLock.packages ?? {};
  for (const path of new Set([...Object.keys(pa), ...Object.keys(pb)])) {
    if (path === "") continue; // root entry mirrors package.json, checked above
    if (!(path in pa)) reasons.push(`lockfile: ${path} added`);
    else if (!(path in pb)) reasons.push(`lockfile: ${path} removed`);
    else if (pa[path].version !== pb[path].version) {
      if (isPatchBump(pa[path].version, pb[path].version)) bumps.push({ name: path.replace(/^.*node_modules\//, ""), from: pa[path].version, to: pb[path].version });
      else reasons.push(`lockfile: ${path} ${pa[path].version} → ${pb[path].version} is not a patch bump`);
    }
  }
  if (reasons.length === 0 && bumps.length === 0) reasons.push("no package version changes");
  return { mergeable: reasons.length === 0, reasons, bumps };
}

function gitShow(ref, file) {
  return execFileSync("git", ["show", `${ref}:${file}`], { encoding: "utf8", timeout: 30_000, maxBuffer: 64 * 1024 * 1024 });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [base, head] = process.argv.slice(2);
  if (!base || !head) {
    console.error("usage: deps-merge-gate.mjs <base-ref> <head-ref>");
    process.exit(2);
  }
  try {
    const changedFiles = execFileSync("git", ["diff", "--name-only", `${base}...${head}`], { encoding: "utf8", timeout: 30_000 })
      .split("\n")
      .filter(Boolean);
    const verdict = evaluateGate({
      changedFiles,
      basePkg: JSON.parse(gitShow(base, "package.json")),
      headPkg: JSON.parse(gitShow(head, "package.json")),
      baseLock: JSON.parse(gitShow(base, "package-lock.json")),
      headLock: JSON.parse(gitShow(head, "package-lock.json")),
    });
    console.log(JSON.stringify(verdict, null, 2));
    process.exit(verdict.mergeable ? 0 : 1);
  } catch (e) {
    console.error(`deps-merge-gate: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(2);
  }
}
