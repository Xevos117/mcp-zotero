#!/usr/bin/env node
// Auto-merge gate for the monthly dependency PR, decided by code and not by the agent. The PR may be
// auto-merged only if:
//   - it touches nothing but package.json, package-lock.json and CHANGELOG.md;
//   - package.json changes only dependency ranges, each by at most a patch;
//   - the lockfile adds or removes no package and keeps its top-level fields;
//   - every lockfile entry that changes version is a semver patch bump, resolved from exactly the npm
//     registry tarball of that name and version (https://registry.npmjs.org/<name>/-/<basename>-<version>.tgz,
//     compared for equality: no "..", "%2e", query or fragment tricks), with an integrity hash, and
//     keeps name, hasInstallScript, bin, os, cpu and the dev/optional/peer flags;
//   - entries whose version does not change keep resolved and integrity (no re-pointing);
//   - every new version has been on the registry for at least MIN_RELEASE_AGE_DAYS.
// Anything else stays for the owner.
// Usage: node deps-merge-gate.mjs <base-ref> <head-ref>  (prints a JSON verdict; exit 0 = mergeable,
// 1 = leave for the owner, 2 = error). The workflow runs main's copy of this file, not the PR's.
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const ALLOWED_FILES = new Set(["package.json", "package-lock.json", "CHANGELOG.md"]);
export const MIN_RELEASE_AGE_DAYS = 7;
const REGISTRY = "https://registry.npmjs.org";
const DEP_FIELDS = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"];
/** Lockfile entry fields that a patch update must never change. */
const FROZEN_ENTRY_FIELDS = ["name", "hasInstallScript", "bin", "os", "cpu", "dev", "optional", "devOptional", "peer", "link", "inBundle"];

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

/** The only tarball URL accepted for name@version: "@scope/pkg" → …/@scope/pkg/-/pkg-<version>.tgz. */
export function registryTarball(name, version) {
  return `${REGISTRY}/${name}/-/${name.split("/").pop()}-${version}.tgz`;
}

/** Package name of a lockfile entry: its `name` field (aliases) or the last node_modules segment of the path. */
export function entryName(path, entry) {
  return entry?.name ?? path.replace(/^.*node_modules\//, "");
}

const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/**
 * Static checks (no network).
 * @param {{ changedFiles: string[], basePkg: object, headPkg: object, baseLock: object, headLock: object }} input
 * @returns {{ mergeable: boolean, reasons: string[], bumps: Array<{ name: string, path: string, from: string, to: string }> }}
 */
export function evaluateGate({ changedFiles, basePkg, headPkg, baseLock, headLock }) {
  const reasons = [];
  const bumps = [];
  const other = changedFiles.filter((f) => !ALLOWED_FILES.has(f));
  if (other.length) reasons.push(`files outside package.json/package-lock.json/CHANGELOG.md: ${other.join(", ")}`);
  if (!changedFiles.includes("package-lock.json")) reasons.push("package-lock.json unchanged: nothing to merge automatically");

  for (const field of DEP_FIELDS) {
    const a = basePkg[field] ?? {};
    const b = headPkg[field] ?? {};
    for (const name of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (!(name in a)) reasons.push(`${field}: ${name} added`);
      else if (!(name in b)) reasons.push(`${field}: ${name} removed`);
      else if (a[name] !== b[name] && !rangeChangeIsPatch(a[name], b[name])) reasons.push(`${field}: ${name} ${a[name]} → ${b[name]} is not a patch range change`);
    }
  }
  const withoutDeps = (obj) => {
    const copy = { ...obj };
    for (const f of DEP_FIELDS) delete copy[f];
    return copy;
  };
  if (!same(withoutDeps(basePkg), withoutDeps(headPkg))) reasons.push("package.json changed outside the dependency fields (e.g. version or scripts)");

  const { packages: basePackages = {}, ...baseTop } = baseLock;
  const { packages: headPackages = {}, ...headTop } = headLock;
  if (!same(baseTop, headTop)) reasons.push("package-lock.json top-level fields changed");
  if (!same(withoutDeps(basePackages[""] ?? {}), withoutDeps(headPackages[""] ?? {}))) reasons.push("lockfile root entry changed outside the dependency fields");

  for (const path of new Set([...Object.keys(basePackages), ...Object.keys(headPackages)])) {
    if (path === "") continue; // root entry: checked above and against package.json
    const a = basePackages[path];
    const b = headPackages[path];
    if (!a) {
      reasons.push(`lockfile: ${path} added`);
      continue;
    }
    if (!b) {
      reasons.push(`lockfile: ${path} removed`);
      continue;
    }
    const changedFrozen = FROZEN_ENTRY_FIELDS.filter((f) => !same(a[f], b[f]));
    if (changedFrozen.length) reasons.push(`lockfile: ${path} changed ${changedFrozen.join(", ")}`);
    if (a.version === b.version) {
      if (!same(a.resolved, b.resolved) || !same(a.integrity, b.integrity)) reasons.push(`lockfile: ${path} resolved/integrity changed without a version change`);
      continue;
    }
    if (!isPatchBump(a.version, b.version)) {
      reasons.push(`lockfile: ${path} ${a.version} → ${b.version} is not a patch bump`);
      continue;
    }
    const name = entryName(path, b);
    if (b.resolved !== registryTarball(name, b.version)) {
      reasons.push(`lockfile: ${path} resolved is not ${registryTarball(name, b.version)} (${b.resolved ?? "missing"})`);
      continue;
    }
    if (typeof b.integrity !== "string" || !/^sha512-/.test(b.integrity)) {
      reasons.push(`lockfile: ${path} has no sha512 integrity`);
      continue;
    }
    bumps.push({ name, path, from: a.version, to: b.version });
  }
  if (reasons.length === 0 && bumps.length === 0) reasons.push("no package version changes");
  return { mergeable: reasons.length === 0, reasons, bumps };
}

/**
 * Every new version must have been published at least `minDays` ago (registry `time` field), so a
 * freshly published malicious patch never merges automatically.
 * @param {Array<{ name: string, to: string }>} bumps
 * @param {{ now?: number, minDays?: number, fetchImpl?: typeof fetch }} [opts]
 * @returns {Promise<string[]>} reasons (empty = all old enough)
 */
export async function checkReleaseAge(bumps, { now = Date.now(), minDays = MIN_RELEASE_AGE_DAYS, fetchImpl = fetch } = {}) {
  const reasons = [];
  const times = new Map();
  for (const { name, to } of bumps) {
    if (!times.has(name)) {
      try {
        const res = await fetchImpl(`${REGISTRY}/${name.replace("/", "%2F")}`, {
          headers: { Accept: "application/json" },
          signal: AbortSignal.timeout(30_000),
        });
        times.set(name, res.ok ? ((await res.json()).time ?? {}) : null);
      } catch {
        times.set(name, null);
      }
    }
    const time = times.get(name);
    const published = time ? Date.parse(time[to]) : NaN;
    if (!Number.isFinite(published)) reasons.push(`${name}@${to}: publication time not available`);
    else if (now - published < minDays * 86_400_000) reasons.push(`${name}@${to}: published less than ${minDays} days ago`);
  }
  return reasons;
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
    if (verdict.mergeable) {
      verdict.reasons.push(...(await checkReleaseAge(verdict.bumps)));
      verdict.mergeable = verdict.reasons.length === 0;
    }
    console.log(JSON.stringify(verdict, null, 2));
    process.exit(verdict.mergeable ? 0 : 1);
  } catch (e) {
    console.error(`deps-merge-gate: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(2);
  }
}
