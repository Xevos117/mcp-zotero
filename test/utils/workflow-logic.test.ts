import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Logica dei workflow dal vivo che nessun test esegue (gira solo su GitHub): controlli testuali sulle condizioni
 * che decidono i check obbligatori, perché una modifica che li rende "verdi senza verifica" non passi inosservata.
 */
const ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const workflow = (name: string) => readFileSync(join(ROOT, ".github", "workflows", name), "utf8");

/** Text of the step with this name, up to the next step or job. */
function step(text: string, name: string): string {
  const start = text.indexOf(`- name: ${name}`);
  expect(start, `step "${name}"`).toBeGreaterThanOrEqual(0);
  const rest = text.slice(start + 1);
  const end = rest.search(/\n {6}- |\n {2}[a-z][\w-]*:\n/);
  return end < 0 ? rest : rest.slice(0, end);
}

describe("workflow dal vivo e agente smoke (WL)", () => {
  const agent = workflow("claude-agent-smoke.yml");
  const live = workflow("live-tests.yml");

  it("WL-01 verify-claims gira sempre dopo un agente riuscito (audit mancante = fallimento), dopo un agente fallito solo con l'audit", () => {
    expect(step(agent, "Verify the agent's claims")).toContain(
      "if: needs.prepare.outputs.run_id != '' && (hashFiles('agent-out/audit.jsonl') != '' || needs.agent-run.result == 'success')"
    );
    expect(step(agent, "No agent calls recorded")).toContain("&& needs.agent-run.result != 'success'");
  });

  it("WL-02 i check obbligatori girano con !cancelled() e verificano changes; il verdetto dell'agente richiede verify riuscito", () => {
    for (const [text, name] of [[agent, "agent-smoke"], [live, "live-tests"]] as const) {
      const job = text.slice(text.indexOf(`name: ${name} # required check name`));
      expect(job.slice(0, 200)).toContain("if: ${{ !cancelled() }}");
      expect(job).toContain('if [ "$CHANGES" != "success" ]; then');
    }
    expect(agent).toContain('if [ "$VERIFY" != "success" ]; then echo "::error::agent-smoke-verify: $VERIFY"; exit 1; fi');
  });

  it("WL-03 una run dal vivo o dell'agente in corso non viene annullata da un push più recente", () => {
    for (const text of [agent, live]) expect(text).toMatch(/concurrency:\n {2}group: [^\n]+\n {2}cancel-in-progress: false\n/);
  });
});
