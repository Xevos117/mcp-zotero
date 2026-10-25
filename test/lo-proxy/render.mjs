// Renders the LibreOffice pages for the agent's visual review (job word-render of claude-agent-smoke.yml) and MERGES
// them into the index.json that test/word-proxy/render.mjs already wrote: a few documents Zotero refreshed in
// LibreOffice (lo-apa, lo-ieee, lo-group, path B embedded itemData), as PNG pages from the PDF the driver exported
// (pdftoppm), each image tagged app: "libreoffice" with a description. So one agent pass reviews both the Word and
// the LibreOffice rendering of the same corpus. Rendering is LibreOffice's; content is meaningful, layout is not.
// Usage: node test/lo-proxy/render.mjs <lo run.sh session dir> <destdir with the word index.json>
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import JSZip from "jszip";
import { prefs } from "./verify.mjs";

/** The LibreOffice documents rendered, and the Word step each mirrors (to extend the shared known issues). */
export const RENDERED_LO = [
  { step: "lo-apa", word: "apa" },
  { step: "lo-ieee", word: "ieee" },
  { step: "lo-group", word: "group" },
];
const SCALE = "110"; // pdftoppm -r (dpi)

/**
 * Merges LibreOffice images into the word index.json: appends the images, and for every known issue that covers a
 * Word step with a LibreOffice counterpart adds that counterpart to its `steps`, so the reviewer may cite the same
 * known issue on an lo page. Never adds reportsRequired or dialog obligations for the lo pages (they have neither).
 */
export function mergeLoIndex(index, loImages, rendered = RENDERED_LO) {
  const byWord = new Map(rendered.map((r) => [r.word, r.step]));
  for (const k of index.knownIssues ?? []) {
    const extra = (k.steps ?? []).map((s) => byWord.get(s)).filter(Boolean).filter((s) => !k.steps.includes(s));
    if (extra.length) k.steps = [...k.steps, ...extra];
  }
  index.images = [...(index.images ?? []), ...loImages];
  return index;
}

async function styleOf(odt) {
  const zip = await JSZip.loadAsync(readFileSync(odt));
  const meta = (await zip.file("meta.xml")?.async("string")) ?? "";
  return prefs(meta).styleInDoc ?? null;
}

if (process.argv[1] && process.argv[1].endsWith("render.mjs")) {
  const [sess, dest] = process.argv.slice(2);
  if (!sess || !dest) {
    console.error("usage: render.mjs <lo session dir> <destdir with the word index.json>");
    process.exit(2);
  }
  const indexPath = join(dest, "index.json");
  const index = JSON.parse(readFileSync(indexPath, "utf8"));
  mkdirSync(dest, { recursive: true });
  const run = (cmd, args) => execFileSync(cmd, args, { timeout: 60_000, encoding: "utf8" });
  const loImages = [];
  for (const { step } of RENDERED_LO) {
    const pdf = join(sess, `${step}.pdf`);
    const odt = join(sess, `${step}.refreshed.odt`);
    if (!existsSync(pdf)) throw new Error(`render: missing ${pdf}`);
    const pages = Number(run("pdfinfo", [pdf]).match(/^Pages:\s*(\d+)/m)?.[1] ?? 0);
    if (!pages) throw new Error(`render: pdfinfo found no pages in ${pdf}`);
    const style = await styleOf(odt);
    for (let page = 1; page <= pages; page++) {
      const image = `${step}-p${page}.png`;
      run("pdftoppm", ["-png", "-r", SCALE, "-f", String(page), "-l", String(page), "-singlefile", pdf, join(dest, `${step}-p${page}`)]);
      loImages.push({
        image,
        document: step,
        app: "libreoffice",
        path: "B (itemData embedded by the product)",
        style,
        page,
        pages,
        description: `LibreOffice: ${step}, pagina ${page}/${pages}${style ? `, stile ${style}` : ""}`,
      });
    }
  }
  mergeLoIndex(index, loImages);
  writeFileSync(indexPath, JSON.stringify(index, null, 2) + "\n");
  console.log(`render(lo): ${loImages.length} pages from ${RENDERED_LO.length} documents → ${dest}`);
}
