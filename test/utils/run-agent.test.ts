import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
// @ts-expect-error plain .mjs script without type declarations
import { loadConfig, federationConfigured, agentEnv, sdkOptions, outcome } from "../../scripts/run-agent.mjs";

const config = (path: string) => readFileSync(new URL(`../../.github/agents/${path}`, import.meta.url), "utf8");

/** Runner degli agenti CI con l'Agent SDK. */
describe("run-agent: runner Agent SDK degli agenti CI (RA)", () => {
  it("RA-01 config dello smoke: ${RUNNER_TEMP} espanso nei percorsi, output fuori dal workspace", () => {
    const c = loadConfig(config("agent-smoke.json"), { RUNNER_TEMP: "/tmp/rt" });
    expect(c.mcpConfig).toBe("/tmp/rt/mcp-zotero.json");
    expect(c.transcript).toBe("/tmp/rt/agent/execution.json");
    expect(c.report).toBe("/tmp/rt/agent/agent-report.json");
    expect(c.skills).toEqual(["test-mcp-zotero"]);
    expect(c.jsonSchema.required).toEqual(["summary", "scenarios"]);
  });

  it("RA-02 variabile mancante o campi obbligatori assenti → errore", () => {
    expect(() => loadConfig(config("agent-smoke.json"), {})).toThrow("environment variable RUNNER_TEMP is not set");
    expect(() => loadConfig(JSON.stringify({ prompt: "p", model: "m" }), {})).toThrow("config: missing transcript");
    expect(() => loadConfig(JSON.stringify({ prompt: "p", model: "m", transcript: "t", jsonSchema: {} }), {})).toThrow("config: missing report");
  });

  it("RA-03 federazione solo con rule id e organization id; l'agente non riceve le variabili per chiedere token OIDC", () => {
    expect(federationConfigured({ ANTHROPIC_FEDERATION_RULE_ID: "r", ANTHROPIC_ORGANIZATION_ID: "o" })).toBe(true);
    expect(federationConfigured({ ANTHROPIC_FEDERATION_RULE_ID: "r", ANTHROPIC_ORGANIZATION_ID: " " })).toBe(false);
    const env = agentEnv({ PATH: "/bin", ACTIONS_ID_TOKEN_REQUEST_URL: "u", ACTIONS_ID_TOKEN_REQUEST_TOKEN: "t" }, { ANTHROPIC_IDENTITY_TOKEN_FILE: "/f" });
    expect(env).toEqual({ PATH: "/bin", ANTHROPIC_IDENTITY_TOKEN_FILE: "/f" });
  });

  it("RA-04 opzioni SDK: dontAsk, solo impostazioni di progetto, MCP per percorso (mai la chiave in riga di comando)", () => {
    const c = loadConfig(config("agent-smoke.json"), { RUNNER_TEMP: "/tmp/rt" });
    const env = { PATH: "/bin" };
    const o = sdkOptions(c, env, new AbortController());
    expect(o.permissionMode).toBe("dontAsk");
    expect(o.settingSources).toEqual(["project"]);
    expect(o.extraArgs).toEqual({ "mcp-config": "/tmp/rt/mcp-zotero.json", "strict-mcp-config": null });
    expect(o.mcpServers).toBeUndefined();
    expect(o.settings).toBe(".claude/agent-smoke/settings.json");
    expect(o.outputFormat).toEqual({ type: "json_schema", schema: c.jsonSchema });
    expect(o.maxBudgetUsd).toBe(2);
    expect(o.maxTurns).toBe(140);
    expect(o.env).toBe(env);
    const deps = sdkOptions(loadConfig(config("deps-update.json"), { RUNNER_TEMP: "/tmp/rt" }), env, new AbortController());
    expect(deps.extraArgs).toEqual({ "mcp-config": ".github/agents/deps-mcp.json", "strict-mcp-config": null });
    expect(deps.outputFormat).toBeUndefined();
    expect(deps.allowedTools).toEqual(expect.arrayContaining(["mcp__context7__resolve-library-id", "mcp__context7__query-docs"]));
    expect(deps.allowedTools.filter((t: string) => t.startsWith("mcp__"))).toHaveLength(2);
    expect(deps.disallowedTools).toEqual(expect.arrayContaining(["Bash(git push *)", "Bash(gh *)", "Bash(npm publish *)"]));
  });

  it("RA-05 esito: errore API, risultato mancante, schema senza output strutturato → fallimento con il motivo", () => {
    const smoke = { jsonSchema: {} };
    expect(outcome(null, smoke)).toEqual({ ok: false, problem: "the agent ended without a result message" });
    expect(outcome({ subtype: "success", is_error: true, result: "Overloaded", api_error_status: 529 }, smoke).problem).toBe(
      "agent error (success, HTTP 529): Overloaded",
    );
    expect(outcome({ subtype: "error_max_turns", is_error: true, errors: ["max turns"] }, {}).problem).toContain("max turns");
    expect(outcome({ subtype: "success", is_error: false }, smoke).problem).toBe("a JSON schema was given but the agent returned no structured output");
    expect(outcome({ subtype: "success", is_error: false, structured_output: { summary: "", scenarios: [] } }, smoke)).toEqual({ ok: true, problem: null });
    expect(outcome({ subtype: "success", is_error: false }, {})).toEqual({ ok: true, problem: null });
  });
});
