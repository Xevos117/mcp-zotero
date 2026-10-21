import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import AjvModule from "ajv";
import addFormatsModule from "ajv-formats";
import { Harness, startHarness } from "../helpers/mcp-harness.js";

/**
 * Metadati di distribuzione: `server.json` (MCP Registry) deve restare valido contro lo schema ufficiale
 * vendorizzato in `test/fixtures/schemas/` e allineato a `package.json` (versione, nome npm, mcpName),
 * altrimenti il job di pubblicazione nel registry di `release.yml` fallisce dopo la pubblicazione su npm.
 * `manifest.json` (estensione Claude Desktop, .mcpb) deve restare allineato a package.json, a server.json
 * (variabili d'ambiente) e ai tool registrati.
 */

const root = fileURLToPath(new URL("../..", import.meta.url));
const readJson = (path: string) => JSON.parse(readFileSync(join(root, path), "utf8"));
const pkg = readJson("package.json");
const server = readJson("server.json");
const manifest = readJson("manifest.json");
const Ajv = ((AjvModule as any).default ?? AjvModule) as new (opts: Record<string, unknown>) => any;
const addFormats = ((addFormatsModule as any).default ?? addFormatsModule) as (ajv: unknown) => void;

/** First sentence of a tool description: the short description listed in manifest.json. */
function firstSentence(text: string): string {
  const m = /^[\s\S]*?[.!?](?=\s|$)/.exec(text.trim());
  return (m ? m[0] : text).replace(/\s+/g, " ").trim();
}

/** Environment variables read by the server code (`process.env.NAME` in src/, tests excluded). */
function envVarsReadBySource(): string[] {
  const names = new Set<string>();
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "__mocks__") walk(path);
      } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
        for (const m of readFileSync(path, "utf8").matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g)) names.add(m[1]);
      }
    }
  };
  walk(join(root, "src"));
  return [...names].sort();
}

describe("metadati di distribuzione: server.json (RM)", () => {
  it("RM-01 server.json valido contro lo schema ufficiale indicato in $schema", () => {
    const schema = readJson("test/fixtures/schemas/server.schema.json");
    expect(server.$schema).toBe(schema.$id);
    const ajv = new Ajv({ strict: false, allErrors: true });
    addFormats(ajv);
    const validate = ajv.compile(schema);
    expect(validate(server), JSON.stringify(validate.errors, null, 2)).toBe(true);
  });

  it("RM-02 versione, nome npm e mcpName allineati a package.json", () => {
    expect(server.version).toBe(pkg.version);
    expect(server.name).toBe(pkg.mcpName);
    expect(server.packages).toHaveLength(1);
    expect(server.packages[0]).toMatchObject({ registryType: "npm", identifier: pkg.name, version: pkg.version });
    // GitHub auth grants io.github.<owner>/* with the owner's exact case (the registry compares by prefix)
    const owner = /github\.com\/([^/]+)\//.exec(pkg.repository.url)![1];
    expect(pkg.mcpName.startsWith(`io.github.${owner}/`)).toBe(true);
    expect(server.repository.url).toBe(`https://github.com/${owner}/mcp-zotero`);
  });

  it("RM-03 environmentVariables = variabili lette dal codice; API key segreta e obbligatoria", () => {
    const vars = server.packages[0].environmentVariables as Array<Record<string, any>>;
    expect(vars.map((v) => v.name).sort()).toEqual(envVarsReadBySource());
    const byName = Object.fromEntries(vars.map((v) => [v.name, v]));
    expect(byName.ZOTERO_API_KEY).toMatchObject({ isRequired: true, isSecret: true });
    expect(vars.filter((v) => v.isSecret).map((v) => v.name)).toEqual(["ZOTERO_API_KEY"]);
    expect(byName.UNSAFE_OPERATIONS).toMatchObject({ choices: ["none", "items", "all"], default: "none" });
    expect(byName.ZOTERO_LIBRARY_TYPE).toMatchObject({ choices: ["user", "group"], default: "user" });
  });
});

describe("metadati di distribuzione: manifest.json dell'estensione Claude Desktop (RM)", () => {
  let h: Harness;
  let tools: Array<{ name: string; description?: string }>;

  beforeAll(async () => {
    h = await startHarness();
    tools = (await h.client.listTools()).tools;
  });
  afterAll(async () => {
    await h.close();
  });

  it("RM-04 manifest valido contro lo schema MCPB della sua manifest_version; versione e Node allineati", () => {
    expect(manifest.manifest_version).toBe("0.3");
    const schema = readJson(`node_modules/@anthropic-ai/mcpb/dist/mcpb-manifest-v${manifest.manifest_version}.schema.json`);
    const ajv = new Ajv({ strict: false, allErrors: true });
    addFormats(ajv);
    const validate = ajv.compile(schema);
    expect(validate(manifest), JSON.stringify(validate.errors, null, 2)).toBe(true);
    expect(manifest.version).toBe(pkg.version);
    expect(manifest.server.entry_point).toBe(pkg.main);
    expect(manifest.server.mcp_config.args).toEqual([`\${__dirname}/${pkg.main}`]);
    const major = (range: string) => /^>=\s*(\d+)/.exec(range)?.[1];
    expect(major(manifest.compatibility.runtimes.node)).toBe(major(pkg.engines.node));
  });

  it("RM-05 tools del manifest = tool registrati, stesso ordine, descrizione = prima frase di quella del codice", () => {
    expect(manifest.tools_generated).toBe(false);
    expect(manifest.tools).toEqual(tools.map((t) => ({ name: t.name, description: firstSentence(t.description ?? "") })));
  });

  it("RM-06 env dal user_config: stesse variabili di server.json, chiave sensibile, opzionali sempre con default", () => {
    const env = manifest.server.mcp_config.env as Record<string, string>;
    const vars = server.packages[0].environmentVariables as Array<Record<string, any>>;
    expect(Object.keys(env).sort()).toEqual(vars.map((v) => v.name).sort());
    const config = manifest.user_config as Record<string, Record<string, any>>;
    for (const v of vars) {
      const key = /^\$\{user_config\.([a-z_]+)\}$/.exec(env[v.name])?.[1];
      expect(key, `${v.name} -> ${env[v.name]}`).toBeDefined();
      const option = config[key!];
      expect(option, key).toBeDefined();
      expect(option.required === true, key).toBe(v.isRequired === true);
      expect(option.sensitive === true, key).toBe(v.isSecret === true);
      // An optional value without a default reaches the server as the literal "${user_config.<key>}"
      if (!option.required) expect(option.default, key).toBe(v.default ?? "");
    }
    expect(Object.keys(config).sort()).toEqual(
      Object.values(env).map((e) => /user_config\.([a-z_]+)/.exec(e)![1]).sort()
    );
  });
});
