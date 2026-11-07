// Genera skills/zotero-skill-mcp-integrations/scripts/inject.js dal sorgente TypeScript
// scripts/skill/inject-cli.ts, impacchettando il nucleo comune delle citazioni (src/citation-injector).
// Lo script della skill non è più copiato a mano: `npm run build:skill` lo rigenera, e il test
// inject-bundle fallisce se il file committato è fuori sincronia.
//
// jszip e fast-xml-parser restano a caricamento resiliente a runtime (import ESM, poi fallback a
// createRequire dalla cwd): uno shim onResolve sostituisce i loro import statici con un modulo che fa
// quel tentativo, così lo script funziona anche in una cartella della skill di sola lettura senza
// node_modules proprio (come lo script scritto a mano di prima).

import { build } from "esbuild";
import { existsSync } from "node:fs";
import { writeFile, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const ENTRY = resolve(ROOT, "scripts/skill/inject-cli.ts");
export const OUTPUT = resolve(ROOT, "skills/zotero-skill-mcp-integrations/scripts/inject.js");

const BANNER =
  "#!/usr/bin/env node\n" +
  "// GENERATED — npm run build:skill (sorgente: scripts/skill/inject-cli.ts). Non modificare a mano.\n";

// Shim resiliente: import ESM, poi fallback a createRequire dalla cwd. Lo specificatore è passato come
// valore a runtime (indice di array) così esbuild non prova a risolverlo e lo lascia come import a runtime.
const JSZIP_SHIM =
  'const _N = "jszip,node:module".split(",");\n' +
  "let _JSZip;\n" +
  "try { _JSZip = (await import(_N[0])).default; }\n" +
  'catch { const _m = await import(_N[1]); _JSZip = _m.createRequire(process.cwd() + "/package.json")("jszip"); }\n' +
  "export default _JSZip;\n";

const FXP_SHIM =
  'const _N = "fast-xml-parser,node:module".split(",");\n' +
  "let _fxp;\n" +
  "try { _fxp = await import(_N[0]); }\n" +
  'catch { const _m = await import(_N[1]); _fxp = _m.createRequire(process.cwd() + "/package.json")("fast-xml-parser"); }\n' +
  "export const XMLParser = _fxp.XMLParser;\n" +
  "export const XMLBuilder = _fxp.XMLBuilder;\n";

/** Plugin: shim per jszip/fast-xml-parser e risoluzione degli import relativi .js → .ts. */
const skillPlugin = {
  name: "skill-bundle",
  setup(pluginBuild) {
    pluginBuild.onResolve({ filter: /^(jszip|fast-xml-parser)$/ }, (args) => {
      // solo gli import statici dai moduli reali diventano shim; l'import dinamico dentro lo shim resta
      if (args.kind !== "import-statement") return null;
      return { path: args.path, namespace: "runtime-dep" };
    });
    pluginBuild.onLoad({ filter: /.*/, namespace: "runtime-dep" }, (args) => ({
      contents: args.path === "jszip" ? JSZIP_SHIM : FXP_SHIM,
      loader: "js",
    }));
    // TS NodeNext usa specificatori .js che puntano a file .ts
    pluginBuild.onResolve({ filter: /\.js$/ }, (args) => {
      if (args.kind !== "import-statement") return null;
      if (!args.path.startsWith("./") && !args.path.startsWith("../")) return null;
      const tsPath = resolve(args.resolveDir, args.path.replace(/\.js$/, ".ts"));
      if (existsSync(tsPath)) return { path: tsPath };
      return null;
    });
  },
};

/** Costruisce lo script della skill e ne restituisce il testo (senza scriverlo). */
export async function buildSkillInject() {
  const result = await build({
    entryPoints: [ENTRY],
    bundle: true,
    format: "esm",
    target: "es2022",
    platform: "node",
    absWorkingDir: ROOT,
    write: false,
    legalComments: "none",
    banner: { js: BANNER },
    logLevel: "silent",
    plugins: [skillPlugin],
  });
  return result.outputFiles[0].text;
}

async function main() {
  const text = await buildSkillInject();
  await writeFile(OUTPUT, text);
  const check = await readFile(OUTPUT, "utf8");
  console.log(`build:skill → ${OUTPUT.slice(ROOT.length + 1)} (${check.length} bytes)`);
}

if (resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1] ?? "")) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
