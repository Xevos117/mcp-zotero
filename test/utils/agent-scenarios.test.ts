import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
// @ts-expect-error plain .mjs module without type declarations
import { loadScenarios, matchesPattern, targetedScenarios, SCENARIOS_PATH } from "../../test/live/agent/scenarios.mjs";

/**
 * Tabella degli scenari mirati della skill test-mcp-zotero (`.claude/skills/test-mcp-zotero/scenarios.json`), letta da
 * prepare.mjs (context.targeted) e da verify-claims.mjs (claims schema 3).
 */
const ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const p = join(dir, d.name);
    if (d.isDirectory()) return d.name === "__mocks__" ? [] : sourceFiles(p);
    return d.name.endsWith(".ts") && !d.name.endsWith(".test.ts") ? [relative(ROOT, p).split("\\").join("/")] : [];
  });
}

describe("scenari mirati della skill dell'agente (SC)", () => {
  const table = loadScenarios();

  it("SC-01 tabella valida: id T-… unici, pattern che esistono nel repository", () => {
    expect(SCENARIOS_PATH).toBe(join(ROOT, ".claude", "skills", "test-mcp-zotero", "scenarios.json"));
    const ids = table.rows.map((r: { id: string }) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    const files = [...sourceFiles(join(ROOT, "src")), "skills/zotero-skill-mcp-integrations/scripts/inject.js"];
    for (const row of table.rows) for (const p of row.files) expect(files.some((f) => matchesPattern(f, p)), `${row.id}: ${p}`).toBe(true);
  });

  it("SC-02 ogni sorgente del server ha almeno uno scenario mirato", () => {
    const unmapped = sourceFiles(join(ROOT, "src")).filter((f) => targetedScenarios([f], table).length === 0);
    expect(unmapped).toEqual([]);
  });

  it("SC-03 scelta per file cambiati: percorso esatto, prefisso /**, ordine della tabella, nessuno per docs e CI", () => {
    expect(targetedScenarios(["src/utils/html-entities.ts"], table)).toEqual(["T-doi"]);
    expect(targetedScenarios(["src/utils/csl-to-zotero.ts"], table)).toEqual(["T-add-items", "T-doi"]);
    expect(targetedScenarios(["src/citation-injector/field-codes.ts", "src/tools/search-library.ts"], table)).toEqual(["T-search", "T-inject"]);
    expect(targetedScenarios(["src/citation-injector-old/x.ts"], table)).toEqual([]);
    expect(targetedScenarios(["README.md", ".github/workflows/test.yml", "  "], table)).toEqual([]);
    expect(matchesPattern("skills/zotero-skill-mcp-integrations/scripts/inject.js", "skills/zotero-skill-mcp-integrations/**")).toBe(true);
  });

  it("SC-04 la skill rimanda alla tabella condivisa (copiata in agent-out/scenarios.json) invece di ripeterla", () => {
    const skill = readFileSync(join(ROOT, ".claude", "skills", "test-mcp-zotero", "SKILL.md"), "utf8");
    expect(skill).toContain("agent-out/scenarios.json");
    expect(skill).toContain("context.targeted");
    for (const row of table.rows) expect(skill, row.id).not.toContain(`| ${row.id} |`);
    expect(readFileSync(join(ROOT, "test", "live", "agent", "prepare.mjs"), "utf8")).toContain('copyFileSync(SCENARIOS_PATH, join(OUT, "scenarios.json"))');
  });
});
