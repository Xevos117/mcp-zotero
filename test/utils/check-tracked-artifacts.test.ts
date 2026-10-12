import { describe, it, expect } from "vitest";
// @ts-expect-error plain .mjs script without type declarations
import { trackedArtifactProblems } from "../../scripts/check-tracked-artifacts.mjs";

/** Guardia CI contro gli output delle run committati (scripts/check-tracked-artifacts.mjs). */
describe("check-tracked-artifacts (TA)", () => {
  // the evidence markers are built at runtime, so this file does not match them itself
  const q = (k: string, v: string) => `{"${k}": "${v}"}`;
  const files: Record<string, string> = {
    "src/server.ts": "export {};",
    "agent-out/claims.json": "{}",
    "agent-audit/audit.jsonl": "",
    ".vitest/live-report.json": "{}",
    "live-artifacts/report.json": "{}",
    "docs/moved-audit.jsonl": q("tool_name", "mcp__zotero__get_collections"),
    "notes/context.json": q("run_tag", "mzt-run:abc"),
    "test/utils/agent-hooks.test.ts": 'const e = { tool_name: "mcp__zotero__add_items" };',
  };

  it("TA-01 percorsi sotto agent-out/, agent-audit/, .vitest/, live-artifacts/ e file con l'aspetto di evidenze dell'agente → segnalati", () => {
    expect(trackedArtifactProblems(Object.keys(files), (f: string) => files[f])).toEqual([
      "agent-out/claims.json: run output under agent-out/",
      "agent-audit/audit.jsonl: run output under agent-audit/",
      ".vitest/live-report.json: run output under .vitest/",
      "live-artifacts/report.json: run output under live-artifacts/",
      "docs/moved-audit.jsonl: looks like agent run evidence (audit log or agent context)",
      "notes/context.json: looks like agent run evidence (audit log or agent context)",
    ]);
  });

  it("TA-02 codice e test che costruiscono gli stessi campi come oggetti, file illeggibili → nessun problema", () => {
    expect(trackedArtifactProblems(["src/server.ts", "test/utils/agent-hooks.test.ts", "sub"], (f: string) => {
      if (f === "sub") throw new Error("EISDIR");
      return files[f];
    })).toEqual([]);
  });
});
