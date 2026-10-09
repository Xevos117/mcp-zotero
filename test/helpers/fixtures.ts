import JSZip from "jszip";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * PDF minimale ma valido (una pagina, testo in Helvetica) con xref corretta,
 * così unpdf può estrarne il testo.
 */
export function makePdf(text = "Hello Zotero"): Buffer {
  const escaped = text.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
  const stream = `BT /F1 18 Tf 72 720 Td (${escaped}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((obj, i) => {
    offsets.push(Buffer.byteLength(out, "latin1"));
    out += `${i + 1} 0 obj\n${obj}\nendobj\n`;
  });
  const xrefOffset = Buffer.byteLength(out, "latin1");
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += `${String(off).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

const W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";

/** Paragrafo Word con un run per ciascun testo (i testi vanno già escapati XML). */
export function para(...runs: string[]): string {
  return `<w:p>${runs.map((t) => `<w:r><w:t xml:space="preserve">${t}</w:t></w:r>`).join("")}</w:p>`;
}

/** Tag zcite come appare dentro document.xml (escapato come lo scrive Word). */
export function zcite(attrs: Record<string, string>): string {
  const a = Object.entries(attrs)
    .map(([k, v]) => `${k}=&quot;${v}&quot;`)
    .join(" ");
  return `&lt;zcite ${a}/&gt;`;
}

export function documentXml(bodyInner: string): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="${W_NS}"><w:body>${bodyInner}<w:sectPr/></w:body></w:document>`;
}

/** .docx reale (zip) con il body indicato. */
export async function makeDocx(bodyInner: string, opts: { omitDocument?: boolean } = {}): Promise<Buffer> {
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'
  );
  zip.file(
    "_rels/.rels",
    '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'
  );
  if (!opts.omitDocument) zip.file("word/document.xml", documentXml(bodyInner));
  return zip.generateAsync({ type: "nodebuffer" });
}

export async function readDocumentXml(docx: Buffer): Promise<string> {
  const zip = await JSZip.loadAsync(docx);
  const entry = zip.file("word/document.xml");
  if (!entry) throw new Error("word/document.xml missing");
  return entry.async("string");
}

export interface TempDir {
  path: string;
  file(name: string, data: Buffer | string): Promise<string>;
  cleanup(): Promise<void>;
}

export async function tempDir(): Promise<TempDir> {
  const path = await mkdtemp(join(tmpdir(), "mcp-zotero-test-"));
  return {
    path,
    async file(name, data) {
      const p = join(path, name);
      await writeFile(p, data);
      return p;
    },
    cleanup: () => rm(path, { recursive: true, force: true }),
  };
}
