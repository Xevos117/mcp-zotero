import http from "node:http";
import { AddressInfo } from "node:net";
import { FakeNet } from "../helpers/fake-net.js";

/**
 * Espone una FakeNet via HTTP su 127.0.0.1 (porta effimera) per il processo
 * server spawnato. Il preload fetch-redirect.mjs riscrive
 * `https://host/path?q` in `http://127.0.0.1:PORT/__proxy/https/host/path?q`;
 * qui si ricostruisce l'URL originale e lo si passa alla tabella di route.
 * Un handler che lancia (errore di rete simulato) chiude il socket.
 */

const HOP_BY_HOP = new Set(["host", "connection", "content-length", "transfer-encoding", "keep-alive"]);

export interface FakeNetServer {
  net: FakeNet;
  port: number;
  close(): Promise<void>;
}

export async function startFakeNetServer(net = new FakeNet()): Promise<FakeNetServer> {
  const server = http.createServer(async (req, res) => {
    const m = (req.url ?? "").match(/^\/__proxy\/(https?)\/([^/?]+)(.*)$/);
    if (!m) {
      res.writeHead(400).end("bad proxy path");
      return;
    }
    const target = `${m[1]}://${m[2]}${m[3] || "/"}`;
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = Buffer.concat(chunks);
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (!HOP_BY_HOP.has(k) && typeof v === "string") headers[k] = v;
    }
    try {
      const r = await net.fetch(target, {
        method: req.method,
        headers,
        body: body.length > 0 ? body : undefined,
      });
      const outHeaders: Record<string, string> = {};
      r.headers.forEach((v, k) => {
        if (!HOP_BY_HOP.has(k)) outHeaders[k] = v;
      });
      const payload = Buffer.from(await r.arrayBuffer());
      res.writeHead(r.status, outHeaders);
      res.end(payload);
    } catch {
      req.socket.destroy();
    }
  });
  server.keepAliveTimeout = 1000;
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    net,
    port,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
