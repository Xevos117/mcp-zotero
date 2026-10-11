import { describe, it, expect } from "vitest";
// @ts-expect-error plain .mjs script without type declarations
import { evaluateGate, isPatchBump } from "../../scripts/deps-merge-gate.mjs";

const pkg = (deps: Record<string, string>, devDeps: Record<string, string> = {}, extra: Record<string, unknown> = {}) => ({
  name: "x",
  version: "2.0.0",
  dependencies: deps,
  devDependencies: devDeps,
  ...extra,
});
const lock = (versions: Record<string, string>) => ({
  lockfileVersion: 3,
  packages: { "": {}, ...Object.fromEntries(Object.entries(versions).map(([n, v]) => [`node_modules/${n}`, { version: v }])) },
});
const FILES = ["package.json", "package-lock.json", "CHANGELOG.md"];

describe("deps-merge-gate", () => {
  it.each([
    ["1.2.3", "1.2.4", true],
    ["1.2.3", "1.3.0", false],
    ["1.2.3", "2.0.0", false],
    ["1.2.3", "1.2.3", false],
    ["1.2.3", "1.2.4-beta.1", false],
    ["0.51.0", "0.51.1", true],
  ])("DG-01 isPatchBump(%s, %s) = %s", (a, b, expected) => {
    expect(isPatchBump(a, b)).toBe(expected);
  });

  it("DG-02 solo patch (diretti e transitivi) e range ^ aggiornati → mergeable", () => {
    const v = evaluateGate({
      changedFiles: FILES,
      basePkg: pkg({ zod: "^4.6.5" }),
      headPkg: pkg({ zod: "^4.6.7" }),
      baseLock: lock({ zod: "4.6.5", "zod/node_modules/x": "1.0.0" }),
      headLock: lock({ zod: "4.6.7", "zod/node_modules/x": "1.0.2" }),
    });
    expect(v).toMatchObject({ mergeable: true, reasons: [] });
    expect(v.bumps).toHaveLength(2);
  });

  it.each([
    ["minor nel lockfile", { baseLock: lock({ zod: "4.6.5" }), headLock: lock({ zod: "4.7.0" }) }, /not a patch bump/],
    ["file di codice toccato", { changedFiles: [...FILES, "src/server.ts"] }, /files outside/],
    ["pacchetto aggiunto", { baseLock: lock({ zod: "4.6.5" }), headLock: lock({ zod: "4.6.6", newdep: "1.0.0" }) }, /added/],
    ["range allargato a una minor", { basePkg: pkg({ zod: "^4.6.5" }), headPkg: pkg({ zod: "^4.7.0" }) }, /not a patch range change/],
    ["versione del pacchetto cambiata", { headPkg: pkg({ zod: "^4.6.5" }, {}, { version: "2.0.1" }) }, /outside the dependency fields/],
    ["lockfile invariato", { changedFiles: ["CHANGELOG.md"], headLock: lock({ zod: "4.6.5" }) }, /unchanged/],
  ])("DG-03 %s → lasciata al proprietario", (_label, override, reason) => {
    const v = evaluateGate({
      changedFiles: FILES,
      basePkg: pkg({ zod: "^4.6.5" }),
      headPkg: pkg({ zod: "^4.6.5" }),
      baseLock: lock({ zod: "4.6.5" }),
      headLock: lock({ zod: "4.6.6" }),
      ...override,
    });
    expect(v.mergeable).toBe(false);
    expect(v.reasons.join("\n")).toMatch(reason);
  });
});
