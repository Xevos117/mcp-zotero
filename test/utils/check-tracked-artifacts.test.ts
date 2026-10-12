import { describe, it, expect } from "vitest";
// @ts-expect-error plain .mjs script without type declarations
import { trackedArtifactProblems } from "../../scripts/check-tracked-artifacts.mjs";

/** Guardia CI contro gli output delle run committati (scripts/check-tracked-artifacts.mjs). */
describe("check-tracked-artifacts (TA)", () => {
  // the evidence markers are built at runtime, so this file does not match them itself
  const json = (o: Record<string, unknown>) => JSON.stringify(o);
  const files: Record<string, string> = {
    "src/server.ts": "export {};",
    "agent-out/claims.json": "{}",
    "agent-audit/audit.jsonl": "",
    ".vitest/live-report.json": "{}",
    "live-artifacts/report.json": "{}",
    "nested/dir/agent-out/x.docx": "",
    "docs/old/.vitest/live-summary.json": "{}",
    "docs/moved-audit.jsonl": json({ ["tool_" + "name"]: "mcp__zotero__get_collections" }),
    "notes/context.json": json({ ["run_" + "tag"]: "mzt-run:abc" }),
    "notes/denials.jsonl": json({ tool_name: "Bash", ["rea" + "son"]: "Denied by the agent smoke harness (command not allowed)." }),
    "notes/claims.json": json({ ["schema_" + "version"]: 2, ["run_" + "id"]: "mv4dx8y5-1d21", ["scen" + "arios"]: [] }),
    "notes/run.jsonl": json({ type: "system", ["session_" + "id"]: "s", tools: ["mcp__" + "zotero__get_collections"] }),
    "notes/summary.json": json({ runId: "x", ["dispos" + "able"]: false, ["left" + "over"]: { items: 0 } }),
    "notes/report.json": json({ ["numTotal" + "TestSuites"]: 17, testResults: [{ name: "/r/test/live/x.live.test" + ".ts" }] }),
    "notes/escaped.json": JSON.stringify({ text: json({ ["run_" + "tag"]: "mzt-run:abc" }) }),
    "test/utils/agent-hooks.test.ts": 'const e = { tool_name: "mcp__zotero__add_items", reason: "Denied by the agent smoke harness" };',
    ".claude/skills/test-mcp-zotero/SKILL.md": '{ "schema_version": 2, "run_id": "<context.run_id>", "scenarios": [] }',
  };

  it("TA-01 cartelle di output a qualunque profondità e file spostati con l'aspetto di evidenze → segnalati (percorso e motivo)", () => {
    expect(trackedArtifactProblems(Object.keys(files), (f: string) => files[f])).toEqual([
      "agent-out/claims.json: run output under agent-out/",
      "agent-audit/audit.jsonl: run output under agent-audit/",
      ".vitest/live-report.json: run output under .vitest/",
      "live-artifacts/report.json: run output under live-artifacts/",
      "nested/dir/agent-out/x.docx: run output under agent-out/",
      "docs/old/.vitest/live-summary.json: run output under .vitest/",
      "docs/moved-audit.jsonl: looks like run evidence (audit log line)",
      "notes/context.json: looks like run evidence (agent context)",
      "notes/denials.jsonl: looks like run evidence (hook denial log)",
      "notes/claims.json: looks like run evidence (agent claims)",
      "notes/run.jsonl: looks like run evidence (agent transcript)",
      "notes/summary.json: looks like run evidence (live summary)",
      "notes/report.json: looks like run evidence (live report)",
      "notes/escaped.json: looks like run evidence (agent context)",
    ]);
  });

  it("TA-02 codice e test che costruiscono gli stessi campi come oggetti, esempio di claims nella skill, voce illeggibile → nessun problema", () => {
    const ok = ["src/server.ts", "test/utils/agent-hooks.test.ts", ".claude/skills/test-mcp-zotero/SKILL.md", "sub"];
    expect(trackedArtifactProblems(ok, (f: string) => {
      if (f === "sub") throw new Error("EISDIR");
      return files[f];
    })).toEqual([]);
  });
});
