import { open, rename, unlink, link, copyFile } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, basename, join } from "node:path";
import { randomBytes } from "node:crypto";

export interface AtomicWriteOptions {
  /** Se false, non sovrascrive un file già esistente: lancia EEXIST (default true). */
  overwrite?: boolean;
}

/**
 * Scrive `data` in `path` in modo atomico: un file temporaneo nella stessa cartella (flag `wx`, così non
 * collide), con fsync, poi `rename` sul percorso finale. Con `overwrite:false` usa `link`+`unlink` (il link
 * fallisce con EEXIST se il file esiste già, senza sovrascriverlo), con fallback a `copyFile` COPYFILE_EXCL
 * dove i link non sono supportati o attraversano filesystem diversi. Il temporaneo viene sempre rimosso.
 *
 * Il rename avviene nella stessa cartella del file finale, quindi è atomico sullo stesso filesystem: un
 * lettore vede o il vecchio file o quello nuovo completo, mai un file a metà (p.es. Word che tiene aperto
 * l'output mentre viene riscritto).
 */
export async function writeFileAtomic(
  path: string,
  data: Buffer | Uint8Array | string,
  opts: AtomicWriteOptions = {}
): Promise<void> {
  const overwrite = opts.overwrite ?? true;
  const dir = dirname(path);
  const tmp = join(dir, `.${basename(path)}.${randomBytes(6).toString("hex")}.tmp`);
  let tmpExists = false;
  try {
    const fh = await open(tmp, "wx");
    tmpExists = true;
    try {
      await fh.writeFile(data);
      await fh.sync();
    } finally {
      await fh.close();
    }

    if (overwrite) {
      await rename(tmp, path);
      tmpExists = false; // il rename ha consumato il temporaneo
      return;
    }

    // overwrite:false → non deve toccare un file esistente
    try {
      await link(tmp, path);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EEXIST") throw err; // il file esiste: non sovrascrivere
      // link non supportato (fs senza hard link) o cross-device: copia che fallisce se l'output esiste
      if (code === "ENOSYS" || code === "EPERM" || code === "EXDEV" || code === "EOPNOTSUPP") {
        await copyFile(tmp, path, constants.COPYFILE_EXCL);
      } else {
        throw err;
      }
    }
  } finally {
    if (tmpExists) {
      try {
        await unlink(tmp);
      } catch {
        /* il temporaneo potrebbe non esistere più: ignora */
      }
    }
  }
}
