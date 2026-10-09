import { vi } from "vitest";

/**
 * Fake di rete per i test: sostituisce `globalThis.fetch` con una tabella di
 * route. Ogni richiesta viene registrata; quelle che non corrispondono a
 * nessuna route falliscono come errore di rete e finiscono in `unmatched`,
 * così nessun test può raggiungere la rete reale.
 *
 * Il pattern di una route si confronta con `host + pathname` (es.
 * "api.zotero.org/users/123/items"): stringa = uguaglianza esatta,
 * RegExp = test. Le route aggiunte per ultime hanno la precedenza.
 */

export interface FakeRequest {
  method: string;
  url: URL;
  headers: Headers;
  body: Buffer | undefined;
  text(): string;
  json<T = unknown>(): T;
  form(): URLSearchParams;
}

export type FakeHandler = (req: FakeRequest, hit: number) => Response | Promise<Response>;

interface Route {
  method: string;
  pattern: string | RegExp;
  handler: FakeHandler;
  hits: number;
}

function toBuffer(body: unknown): Buffer | undefined {
  if (body === undefined || body === null) return undefined;
  if (typeof body === "string") return Buffer.from(body, "utf-8");
  if (Buffer.isBuffer(body)) return body;
  if (body instanceof URLSearchParams) return Buffer.from(body.toString(), "utf-8");
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  if (ArrayBuffer.isView(body)) {
    return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  }
  throw new Error(`fake-net: unsupported body type ${Object.prototype.toString.call(body)}`);
}

function matches(pattern: string | RegExp, url: URL): boolean {
  const target = `${url.host}${url.pathname}`;
  return typeof pattern === "string" ? target === pattern : pattern.test(target);
}

export class FakeNet {
  readonly calls: FakeRequest[] = [];
  readonly unmatched: string[] = [];
  private routes: Route[] = [];

  on(method: string, pattern: string | RegExp, handler: FakeHandler | Response): this {
    const h: FakeHandler =
      typeof handler === "function" ? handler : () => (handler as Response).clone();
    this.routes.unshift({ method: method.toUpperCase(), pattern, handler: h, hits: 0 });
    return this;
  }

  /** Richieste registrate che corrispondono a metodo + pattern. */
  requests(method: string, pattern: string | RegExp): FakeRequest[] {
    return this.calls.filter(
      (c) => c.method === method.toUpperCase() && matches(pattern, c.url)
    );
  }

  /** Richieste registrate verso un host. */
  toHost(host: string): FakeRequest[] {
    return this.calls.filter((c) => c.url.host === host);
  }

  readonly fetch = async (input: unknown, init?: RequestInit): Promise<Response> => {
    let urlString: string;
    let method = init?.method ?? "GET";
    let headers = new Headers(init?.headers as HeadersInit | undefined);
    let rawBody: unknown = init?.body;

    if (input instanceof Request) {
      urlString = input.url;
      method = init?.method ?? input.method;
      if (!init?.headers) headers = new Headers(input.headers);
      if (rawBody === undefined && input.body) rawBody = Buffer.from(await input.arrayBuffer());
    } else {
      urlString = String(input);
    }

    const url = new URL(urlString);
    const body = toBuffer(rawBody);
    const req: FakeRequest = {
      method: method.toUpperCase(),
      url,
      headers,
      body,
      text: () => (body ? body.toString("utf-8") : ""),
      json: <T>() => JSON.parse(body ? body.toString("utf-8") : "null") as T,
      form: () => new URLSearchParams(body ? body.toString("utf-8") : ""),
    };
    this.calls.push(req);

    const route = this.routes.find((r) => r.method === req.method && matches(r.pattern, url));
    if (!route) {
      this.unmatched.push(`${req.method} ${url.href}`);
      throw new TypeError(`fetch failed (fake-net: no route for ${req.method} ${url.href})`);
    }
    route.hits++;
    return route.handler(req, route.hits);
  };

  install(): this {
    vi.stubGlobal("fetch", this.fetch);
    return this;
  }
}

// ─── Costruttori di Response ────────────────────────────────────

export function jsonResponse(
  data: unknown,
  init: { status?: number; headers?: Record<string, string> } = {}
): Response {
  return new Response(JSON.stringify(data), {
    status: init.status ?? 200,
    headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
}

export function statusResponse(status: number, text = "", headers: Record<string, string> = {}): Response {
  const nullBody = status === 204 || status === 304;
  return new Response(nullBody ? null : text, { status, headers });
}

export function binaryResponse(
  data: Buffer | Uint8Array,
  contentType = "application/pdf",
  status = 200
): Response {
  return new Response(new Uint8Array(data), { status, headers: { "Content-Type": contentType } });
}

/** Handler che simula un errore di rete (DNS, connessione rifiutata, ...). */
export function networkError(message = "fetch failed"): FakeHandler {
  return () => {
    throw new TypeError(message);
  };
}
