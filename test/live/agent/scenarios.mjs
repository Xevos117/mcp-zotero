// Targeted scenarios (T-…) of the test-mcp-zotero skill: the table in .claude/skills/test-mcp-zotero/scenarios.json,
// matched against the files a change touches. prepare.mjs writes the selected ids into context.json (the agent runs
// them), verify-claims.mjs recomputes them from the trusted context (claims schema 3 must report each).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const SCENARIOS_PATH = fileURLToPath(new URL("../../../.claude/skills/test-mcp-zotero/scenarios.json", import.meta.url));

export function loadScenarios(path = SCENARIOS_PATH) {
  const table = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(table?.rows) || !table.rows.every((r) => /^T-[a-z-]+$/.test(String(r?.id)) && Array.isArray(r.files) && r.files.length && typeof r.scenario === "string")) {
    throw new Error(`${path}: every row needs an id T-…, files and a scenario`);
  }
  return table;
}

/** A pattern is an exact path, or a directory prefix ending in "/**". */
export function matchesPattern(file, pattern) {
  return pattern.endsWith("/**") ? file.startsWith(pattern.slice(0, -2)) : file === pattern;
}

/** Ids of the rows selected by the changed files, in table order. */
export function targetedScenarios(changedFiles, table) {
  const files = (changedFiles ?? []).map((f) => String(f).trim()).filter(Boolean);
  return table.rows.filter((r) => files.some((f) => r.files.some((p) => matchesPattern(f, p)))).map((r) => r.id);
}
