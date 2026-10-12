#!/usr/bin/env node
// Runs a CI agent with the Claude Agent SDK (@anthropic-ai/claude-agent-sdk), following a project skill.
// The SDK runs with its own defaults.
//
// Authentication: Anthropic Workload Identity Federation. With ANTHROPIC_FEDERATION_RULE_ID and
// ANTHROPIC_ORGANIZATION_ID set (plus ANTHROPIC_SERVICE_ACCOUNT_ID / ANTHROPIC_WORKSPACE_ID), this script fetches
// a GitHub Actions OIDC token (job permission `id-token: write`), writes it to a 600 file and refreshes it every
// 4 minutes; the agent process exchanges it for a short-lived Anthropic token. ACTIONS_ID_TOKEN_REQUEST_* are
// removed from the agent's environment, so the agent cannot mint tokens itself.
//
// Usage: node scripts/run-agent.mjs <config.json>
// Config (JSON): prompt, model, skills, tools, allowedTools, disallowedTools, settings (path), mcpConfig (path,
// passed by path so the Zotero key never appears on a command line), maxTurns, maxBudgetUsd, timeoutMinutes,
// jsonSchema (object, optional), transcript (output path), report (output path, with jsonSchema).
// Values "${VAR}" in mcpConfig are expanded from the environment (e.g. ${RUNNER_TEMP}).
// Exit 0 only if the agent finished without error (and returned the structured report, if a schema is given).
// The log shows only metadata (turns, cost, stop reason) and the error text, never the agent's messages.
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const OIDC_AUDIENCE = "https://api.anthropic.com";
const REFRESH_MS = 4 * 60 * 1000;
// Only the runner needs these: the agent must not be able to request OIDC tokens.
const STRIPPED_ENV = ["ACTIONS_ID_TOKEN_REQUEST_URL", "ACTIONS_ID_TOKEN_REQUEST_TOKEN"];
const REQUIRED = ["prompt", "model", "transcript"];

/** Config with ${VAR} expanded in path fields; throws on a missing field or variable. */
export function loadConfig(text, env) {
  const config = JSON.parse(text);
  const missing = REQUIRED.filter((k) => !config[k]);
  if (config.jsonSchema && !config.report) missing.push("report");
  if (missing.length) throw new Error(`config: missing ${missing.join(", ")}`);
  const expand = (v) =>
    typeof v === "string"
      ? v.replace(/\$\{([A-Z0-9_]+)\}/g, (_m, name) => {
          if (!env[name]) throw new Error(`config: environment variable ${name} is not set`);
          return env[name];
        })
      : v;
  for (const k of ["settings", "mcpConfig", "transcript", "report"]) config[k] = expand(config[k]);
  return config;
}

/** True if the federation variables are set (the same check as the agent's own env detection). */
export function federationConfigured(env) {
  return Boolean(env.ANTHROPIC_FEDERATION_RULE_ID?.trim() && env.ANTHROPIC_ORGANIZATION_ID?.trim());
}

/** The agent process environment: the runner's, without the OIDC request variables. */
export function agentEnv(env, extra = {}) {
  const out = { ...env, ...extra };
  for (const k of STRIPPED_ENV) delete out[k];
  return out;
}

/** SDK query options from the config. */
export function sdkOptions(config, env, abortController) {
  const extraArgs = {};
  if (config.mcpConfig) {
    extraArgs["mcp-config"] = config.mcpConfig;
    extraArgs["strict-mcp-config"] = null;
  }
  return {
    model: config.model,
    cwd: config.cwd ?? process.cwd(),
    systemPrompt: { type: "preset", preset: "claude_code" },
    // project only: CLAUDE.md and .claude/skills of this checkout, no user or local settings
    settingSources: ["project"],
    ...(config.skills ? { skills: config.skills } : {}),
    ...(config.tools ? { tools: config.tools } : {}),
    allowedTools: config.allowedTools ?? [],
    disallowedTools: config.disallowedTools ?? [],
    permissionMode: "dontAsk",
    ...(config.settings ? { settings: config.settings } : {}),
    maxTurns: config.maxTurns ?? 100,
    ...(config.maxBudgetUsd ? { maxBudgetUsd: config.maxBudgetUsd } : {}),
    ...(config.jsonSchema ? { outputFormat: { type: "json_schema", schema: config.jsonSchema } } : {}),
    extraArgs,
    env,
    abortController,
  };
}

/** Outcome of the run from the SDK result message: { ok, problem }. */
export function outcome(result, config) {
  if (!result) return { ok: false, problem: "the agent ended without a result message" };
  if (result.is_error || result.subtype !== "success") {
    const why = result.result || (result.errors ?? []).join("; ") || result.terminal_reason || result.subtype;
    return { ok: false, problem: `agent error (${result.subtype}${result.api_error_status ? `, HTTP ${result.api_error_status}` : ""}): ${why}` };
  }
  if (config.jsonSchema && (result.structured_output === undefined || result.structured_output === null)) {
    return { ok: false, problem: "a JSON schema was given but the agent returned no structured output" };
  }
  return { ok: true, problem: null };
}

async function fetchOidcToken(env) {
  const url = new URL(env.ACTIONS_ID_TOKEN_REQUEST_URL);
  url.searchParams.set("audience", OIDC_AUDIENCE);
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}` },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`GitHub OIDC token request failed: HTTP ${res.status}`);
  const { value } = await res.json();
  if (!value) throw new Error("GitHub OIDC token request returned no token");
  return value;
}

/**
 * Writes the GitHub OIDC token for the federation exchange and keeps it fresh (GitHub tokens are short-lived
 * and single-use; the agent re-reads the file when it refreshes its Anthropic token). Returns the extra
 * environment for the agent and a stop() that removes the token and the cached credential.
 */
async function setupFederation(env) {
  if (!env.ACTIONS_ID_TOKEN_REQUEST_URL || !env.ACTIONS_ID_TOKEN_REQUEST_TOKEN) {
    throw new Error("federation configured but no GitHub OIDC token available: the job needs `permissions: id-token: write`");
  }
  const dir = join(env.RUNNER_TEMP || "/tmp", "anthropic-federation");
  const tokenFile = join(dir, "identity-token");
  mkdirSync(join(dir, "config", "configs"), { recursive: true, mode: 0o700 });
  // A profile switches the agent to the file-backed federation path, which caches the exchanged token.
  writeFileSync(join(dir, "config", "configs", "default.json"), JSON.stringify({ version: "1.0", authentication: { type: "oidc_federation" } }), { mode: 0o600 });
  const write = async () => {
    const token = await fetchOidcToken(env);
    console.log(`::add-mask::${token}`);
    writeFileSync(tokenFile, token, { mode: 0o600 });
    chmodSync(tokenFile, 0o600);
  };
  await write();
  const timer = setInterval(() => write().catch((e) => console.log(`::warning::OIDC token refresh failed: ${e.message}`)), REFRESH_MS);
  timer.unref();
  return {
    extra: { ANTHROPIC_IDENTITY_TOKEN_FILE: tokenFile, ANTHROPIC_CONFIG_DIR: join(dir, "config"), ANTHROPIC_PROFILE: "default" },
    stop: () => {
      clearInterval(timer);
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function main() {
  const configPath = process.argv[2];
  if (!configPath) throw new Error("usage: node scripts/run-agent.mjs <config.json>");
  const config = loadConfig(readFileSync(configPath, "utf8"), process.env);
  const { query } = await import("@anthropic-ai/claude-agent-sdk");

  const federation = federationConfigured(process.env) ? await setupFederation(process.env) : null;
  if (federation) console.log("Workload identity federation: GitHub OIDC token ready");
  const abortController = new AbortController();
  const timeoutMin = config.timeoutMinutes ?? 40;
  const timer = setTimeout(() => abortController.abort(new Error(`timeout after ${timeoutMin} min`)), timeoutMin * 60_000);

  const messages = [];
  let result = null;
  let thrown = null;
  try {
    const env = agentEnv(process.env, federation?.extra);
    for await (const message of query({ prompt: config.prompt, options: sdkOptions(config, env, abortController) })) {
      messages.push(message);
      if (message.type === "system" && message.subtype === "init") console.log(`agent started: model ${message.model}, ${message.tools?.length ?? 0} tools, MCP ${JSON.stringify((message.mcp_servers ?? []).map((s) => `${s.name}:${s.status}`))}`);
      if (message.type === "result") result = message;
    }
  } catch (e) {
    thrown = e;
  } finally {
    clearTimeout(timer);
    federation?.stop();
  }

  mkdirSync(dirname(config.transcript), { recursive: true });
  writeFileSync(config.transcript, JSON.stringify(messages, null, 2));
  if (config.report) {
    mkdirSync(dirname(config.report), { recursive: true });
    writeFileSync(config.report, JSON.stringify(result?.structured_output ?? {}, null, 2));
  }
  if (result) {
    console.log(`agent finished: ${result.subtype}, ${result.num_turns} turns, ${Math.round(result.duration_ms / 1000)} s, estimated cost $${(result.total_cost_usd ?? 0).toFixed(2)}`);
  }
  // the SDK also throws after an error result: report the result's reason, which names the API error
  const checked = outcome(result, config);
  const { ok, problem } = !checked.ok || !thrown ? checked : { ok: false, problem: `agent run failed: ${thrown.message}` };
  if (!ok) {
    console.log(`::error::${problem}`);
    process.exit(1);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.log(`::error::${e.message}`);
    process.exit(1);
  });
}
