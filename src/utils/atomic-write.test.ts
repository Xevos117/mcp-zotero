import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFile, readdir, writeFile, mkdir, chmod } from "node:fs/promises";
import { join } from "node:path";
import { tempDir, TempDir } from "../../test/helpers/fixtures.js";
import { writeFileAtomic } from "./atomic-write.js";

describe("writeFileAtomic", () => {
  let dir: TempDir;
  beforeEach(async () => {
    dir = await tempDir();
  });
  afterEach(async () => {
    await dir.cleanup();
  });

  const leftovers = async () => (await readdir(dir.path)).filter((n) => n.includes(".tmp"));

  it("AW-01 scrive il contenuto e non lascia file temporanei", async () => {
    const target = join(dir.path, "out.bin");
    await writeFileAtomic(target, Buffer.from("hello"));
    expect((await readFile(target)).toString()).toBe("hello");
    expect(await leftovers()).toEqual([]);
  });

  it("AW-02 overwrite:true (default) sostituisce un file esistente", async () => {
    const target = join(dir.path, "out.bin");
    await writeFile(target, "old");
    await writeFileAtomic(target, Buffer.from("new"));
    expect((await readFile(target)).toString()).toBe("new");
    expect(await leftovers()).toEqual([]);
  });

  it("AW-03 overwrite:false rifiuta un file esistente (EEXIST) e non lo tocca", async () => {
    const target = join(dir.path, "out.bin");
    await writeFile(target, "keep");
    await expect(writeFileAtomic(target, Buffer.from("new"), { overwrite: false })).rejects.toMatchObject({ code: "EEXIST" });
    expect((await readFile(target)).toString()).toBe("keep");
    expect(await leftovers()).toEqual([]);
  });

  it("AW-04 overwrite:false crea il file se non esiste", async () => {
    const target = join(dir.path, "fresh.bin");
    await writeFileAtomic(target, Buffer.from("fresh"), { overwrite: false });
    expect((await readFile(target)).toString()).toBe("fresh");
    expect(await leftovers()).toEqual([]);
  });

  it.skipIf(process.getuid?.() === 0)("AW-05 cartella non scrivibile: errore e nessun temporaneo", async () => {
    const ro = join(dir.path, "ro");
    await mkdir(ro);
    await chmod(ro, 0o555);
    try {
      await expect(writeFileAtomic(join(ro, "x.bin"), Buffer.from("x"))).rejects.toMatchObject({ code: "EACCES" });
      expect((await readdir(ro))).toEqual([]);
    } finally {
      await chmod(ro, 0o755);
    }
  });
});
