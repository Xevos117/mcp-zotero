import { createServer, Server } from "node:http";
import { AddressInfo } from "node:net";
import { makePdf } from "../../helpers/fixtures.js";

/**
 * Server HTTP locale (127.0.0.1, porta casuale) con i file che i tool scaricano: PDF piccoli e validi,
 * HTML servito come PDF, una pagina HTML e un 404. Evita di dipendere da siti esterni per i casi
 * deterministici di import_pdf_to_zotero.
 */

export const FIXTURE_PDF_TEXT = "mcp-zotero live suite fixture PDF";

export interface FixtureServer {
  base: string;
  pdf: Buffer;
  /** Byte serviti con status 200 (per stimare quanto è stato caricato su Zotero). */
  bytesServed: () => number;
  close(): Promise<void>;
}

export async function startFixtureServer(): Promise<FixtureServer> {
  const pdf = makePdf(FIXTURE_PDF_TEXT);
  let served = 0;
  const server: Server = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0];
    const send = (status: number, type: string, body: string | Buffer, extra: Record<string, string> = {}) => {
      if (status === 200) served += Buffer.byteLength(body);
      res.writeHead(status, { "content-type": type, ...extra });
      res.end(body);
    };
    if (path === "/paper.pdf") return send(200, "application/pdf", pdf);
    if (path === "/download") {
      return send(200, "application/pdf", pdf, { "content-disposition": 'attachment; filename="mzt-fixture-disposition.pdf"' });
    }
    if (path === "/login.pdf") return send(200, "application/pdf", "<html><body>Login required</body></html>");
    if (path === "/page.html") return send(200, "text/html", "<!doctype html><html><body>hello</body></html>");
    return send(404, "text/plain", "not found");
  });
  server.requestTimeout = 10_000;
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    pdf,
    bytesServed: () => served,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
