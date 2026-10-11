import { describe, it, expect } from "vitest";
// @ts-expect-error plain .mjs script without type declarations
import { evaluateGate, isPatchBump, checkReleaseAge } from "../../scripts/deps-merge-gate.mjs";

const REG = "https://registry.npmjs.org";
const pkg = (deps: Record<string, string>, devDeps: Record<string, string> = {}, extra: Record<string, unknown> = {}) => ({
  name: "x",
  version: "2.0.0",
  dependencies: deps,
  devDependencies: devDeps,
  ...extra,
});
type Entry = Record<string, unknown>;
const entry = (name: string, version: string, extra: Entry = {}): Entry => ({
  version,
  resolved: `${REG}/${name}/-/${name.split("/").pop()}-${version}.tgz`,
  integrity: `sha512-${name}-${version}`,
  ...extra,
});
const lock = (entries: Record<string, Entry>, top: Record<string, unknown> = {}) => ({
  name: "x",
  version: "2.0.0",
  lockfileVersion: 3,
  requires: true,
  ...top,
  packages: { "": { name: "x", version: "2.0.0" }, ...Object.fromEntries(Object.entries(entries).map(([n, e]) => [`node_modules/${n}`, e])) },
});
const FILES = ["package.json", "package-lock.json", "CHANGELOG.md"];
const base = () => ({
  changedFiles: FILES,
  basePkg: pkg({ zod: "^4.6.5" }),
  headPkg: pkg({ zod: "^4.6.5" }),
  baseLock: lock({ zod: entry("zod", "4.6.5") }),
  headLock: lock({ zod: entry("zod", "4.6.6") }),
});

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

  it("DG-02 solo patch (diretti e transitivi), dal registry con integrity, range ^ aggiornati → mergeable", () => {
    const v = evaluateGate({
      ...base(),
      headPkg: pkg({ zod: "^4.6.6" }),
      baseLock: lock({ zod: entry("zod", "4.6.5"), "zod/node_modules/x": entry("x", "1.0.0") }),
      headLock: lock({ zod: entry("zod", "4.6.6"), "zod/node_modules/x": entry("x", "1.0.2") }),
    });
    expect(v).toMatchObject({ mergeable: true, reasons: [] });
    expect(v.bumps.map((b: { name: string }) => b.name)).toEqual(["zod", "x"]);
  });

  it.each([
    ["minor nel lockfile", { headLock: lock({ zod: entry("zod", "4.7.0") }) }, /not a patch bump/],
    ["file di codice toccato", { changedFiles: [...FILES, "src/server.ts"] }, /files outside/],
    ["pacchetto aggiunto", { headLock: lock({ zod: entry("zod", "4.6.6"), newdep: entry("newdep", "1.0.0") }) }, /added/],
    ["range allargato a una minor", { headPkg: pkg({ zod: "^4.7.0" }) }, /not a patch range change/],
    ["versione del pacchetto cambiata", { headPkg: pkg({ zod: "^4.6.5" }, {}, { version: "2.0.1" }) }, /outside the dependency fields/],
    ["lockfile invariato", { changedFiles: ["CHANGELOG.md"], headLock: lock({ zod: entry("zod", "4.6.5") }) }, /unchanged/],
  ])("DG-03 %s → lasciata al proprietario", (_label, override, reason) => {
    const v = evaluateGate({ ...base(), ...override });
    expect(v.mergeable).toBe(false);
    expect(v.reasons.join("\n")).toMatch(reason);
  });

  // Aggiramenti trovati dalla revisione di sicurezza
  it.each([
    [
      "resolved verso un server qualsiasi + hasInstallScript",
      { headLock: lock({ zod: entry("zod", "4.6.6", { resolved: "https://evil.example/zod-4.6.6.tgz", hasInstallScript: true }) }) },
      /hasInstallScript|resolved outside/,
    ],
    [
      "stessa versione ripuntata su git+ssh",
      { headLock: lock({ zod: entry("zod", "4.6.5", { resolved: "git+ssh://git@github.com/evil/zod.git#abc" }) }) },
      /resolved\/integrity changed without a version change/,
    ],
    [
      "alias npm: stesso path, pacchetto diverso",
      { headLock: lock({ zod: entry("evil-zod", "4.6.6", { name: "evil-zod" }) }) },
      /changed name/,
    ],
    ["nuovo bin", { headLock: lock({ zod: entry("zod", "4.6.6", { bin: { zod: "cli.js" } }) }) }, /changed bin/],
    ["integrity assente", { headLock: lock({ zod: entry("zod", "4.6.6", { integrity: undefined }) }) }, /no sha512 integrity/],
    ["resolved dal registry ma con un altro nome", { headLock: lock({ zod: entry("zod", "4.6.6", { resolved: `${REG}/evil/-/evil-4.6.6.tgz` }) }) }, /resolved outside/],
    ["campi di primo livello del lockfile", { headLock: lock({ zod: entry("zod", "4.6.6") }, { lockfileVersion: 2 }) }, /top-level fields/],
    ["os/cpu cambiati", { headLock: lock({ zod: entry("zod", "4.6.6", { os: ["linux"] }) }) }, /changed os/],
  ])("DG-04 %s → lasciata al proprietario", (_label, override, reason) => {
    const v = evaluateGate({ ...base(), ...override });
    expect(v.mergeable).toBe(false);
    expect(v.reasons.join("\n")).toMatch(reason);
  });

  describe("DG-05 età minima della release (7 giorni)", () => {
    const now = Date.parse("2026-11-01T00:00:00Z");
    const registry = (time: Record<string, string>) => (async () => new Response(JSON.stringify({ time }), { status: 200 })) as unknown as typeof fetch;

    it("pubblicata da più di 7 giorni → nessun motivo", async () => {
      expect(await checkReleaseAge([{ name: "zod", to: "4.6.6" }], { now, fetchImpl: registry({ "4.6.6": "2026-10-20T00:00:00Z" }) })).toEqual([]);
    });
    it("pubblicata ieri → lasciata al proprietario", async () => {
      const r = await checkReleaseAge([{ name: "zod", to: "4.6.6" }], { now, fetchImpl: registry({ "4.6.6": "2026-10-31T00:00:00Z" }) });
      expect(r).toEqual([expect.stringMatching(/less than 7 days/)]);
    });
    it("registry non raggiungibile o versione senza data → lasciata al proprietario", async () => {
      const down = (async () => {
        throw new TypeError("fetch failed");
      }) as unknown as typeof fetch;
      expect(await checkReleaseAge([{ name: "zod", to: "4.6.6" }], { now, fetchImpl: down })).toEqual([expect.stringMatching(/not available/)]);
      expect(await checkReleaseAge([{ name: "zod", to: "4.6.6" }], { now, fetchImpl: registry({}) })).toEqual([expect.stringMatching(/not available/)]);
    });
  });
});
