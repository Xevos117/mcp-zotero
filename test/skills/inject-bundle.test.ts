import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
// @ts-expect-error .mjs senza dichiarazioni di tipo
import { buildSkillInject, OUTPUT } from "../../scripts/build-skill.mjs";

/**
 * Lo script della skill (skills/.../inject.js) è generato da scripts/skill/inject-cli.ts con
 * `npm run build:skill`. Questo test lo ricostruisce in memoria e lo confronta con il file committato:
 * se qualcuno modifica il sorgente (o inject.js a mano) senza rigenerare, fallisce. Rigenerare con
 * `npm run build:skill`.
 */
describe("inject-bundle (script della skill in sincronia col sorgente)", () => {
  it("il file committato è identico alla ricostruzione in memoria", async () => {
    const rebuilt = await buildSkillInject();
    const committed = await readFile(OUTPUT, "utf8");
    expect(committed).toBe(rebuilt);
  }, 60_000);

  it("ha l'intestazione GENERATED e lo shebang", async () => {
    const committed = await readFile(OUTPUT, "utf8");
    expect(committed.startsWith("#!/usr/bin/env node\n")).toBe(true);
    expect(committed).toContain("GENERATED — npm run build:skill");
  });
});
