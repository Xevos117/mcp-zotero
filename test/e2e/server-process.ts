import { spawn } from "node:child_process";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { FakeNetServer } from "./fake-net-server.js";
import { USER_ID } from "../helpers/zotero-fake.js";

/**
 * Avvio del server compilato per gli e2e: `node --import fetch-redirect.mjs build/server.js`
 * su stdio, con ogni fetch reindirizzata alla FakeNet locale. Ogni attesa ha un bound
 * e il processo figlio viene ucciso con SIGKILL se sopravvive alla chiusura.
 */

export const ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
export const SERVER = join(ROOT, "build", "server.js");
export const PRELOAD = join(ROOT, "test", "e2e", "fetch-redirect.mjs");
export const CALL_TIMEOUT_MS = 15_000;
export const KILL_AFTER_MS = 5_000;

export interface Spawned {
  client: Client;
  transport: StdioClientTransport;
  stderr: () => string;
  close(): Promise<void>;
}

export async function spawnServer(fake: FakeNetServer, cwd: string, extraEnv: Record<string, string>): Promise<Spawned> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", PRELOAD, SERVER],
    cwd, // cartella vuota: nessun .env raccolto da dotenv
    env: {
      PATH: process.env.PATH ?? "",
      ZOTERO_API_KEY: "e2e-fake-key",
      ZOTERO_USER_ID: USER_ID,
      FAKE_NET_PORT: String(fake.port),
      ...extraEnv,
    },
    stderr: "pipe",
  });
  let err = "";
  transport.stderr?.on("data", (d: Buffer) => (err += d.toString()));
  const client = new Client({ name: "e2e-client", version: "0.0.0" });
  await client.connect(transport, { timeout: CALL_TIMEOUT_MS });
  return {
    client,
    transport,
    stderr: () => err,
    async close() {
      const pid = transport.pid;
      await Promise.race([client.close(), new Promise((r) => setTimeout(r, KILL_AFTER_MS))]);
      if (pid) {
        try {
          process.kill(pid, 0);
          process.kill(pid, "SIGKILL"); // ancora vivo dopo il bound → kill forzato
        } catch {
          // già terminato
        }
      }
    },
  };
}

export async function call(s: Spawned, name: string, args: Record<string, unknown>) {
  try {
    const r = (await s.client.callTool({ name, arguments: args }, undefined, { timeout: CALL_TIMEOUT_MS })) as {
      content: Array<{ type: string; text: string }>;
      isError?: boolean;
    };
    const text = r.content?.[0]?.text ?? "";
    let json: any;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    return { isError: r.isError === true, text, json };
  } catch (e) {
    return { isError: true, text: e instanceof Error ? e.message : String(e), json: undefined };
  }
}

/** Avvia il server aspettandosi che esca da solo (configurazione rifiutata); SIGKILL dopo il bound. */
export function runUntilExit(
  fake: FakeNetServer,
  cwd: string,
  env: Record<string, string>
): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, ["--import", PRELOAD, SERVER], {
      cwd,
      env: { PATH: process.env.PATH ?? "", FAKE_NET_PORT: String(fake.port), ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let err = "";
    child.stderr.on("data", (d: Buffer) => (err += d.toString()));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`il server non è uscito entro ${KILL_AFTER_MS}ms`));
    }, KILL_AFTER_MS);
    child.on("exit", (c) => {
      clearTimeout(timer);
      resolvePromise({ code: c, stderr: err });
    });
  });
}
