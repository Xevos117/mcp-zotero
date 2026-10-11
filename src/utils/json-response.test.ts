import { describe, it, expect } from "vitest";
import { InvalidJsonResponseError, readJsonObject } from "./json-response.js";

const res = (body: string | null, status = 200, type = "text/html; charset=utf-8") => new Response(body, { status, headers: { "Content-Type": type } });

describe("readJsonObject", () => {
  it("returns a JSON object body", async () => {
    expect(await readJsonObject(res('{"a":1}', 200, "application/json"))).toEqual({ a: 1 });
  });

  it.each([
    ["HTML", "<!DOCTYPE html><html></html>"],
    ["empty body", ""],
    ["null", "null"],
    ["array", "[1]"],
    ["number", "3"],
  ])("rejects %s with status and content type, not the JSON.parse message", async (_label, body) => {
    const err = await readJsonObject(res(body)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InvalidJsonResponseError);
    expect((err as Error).message).toBe("response is not a JSON object (HTTP 200, text/html)");
  });

  it("keeps a timeout while reading the body as it is (callers map it to a timeout error)", async () => {
    const timeout = Object.assign(new Error("aborted"), { name: "TimeoutError" });
    const response = { status: 200, headers: new Headers(), json: () => Promise.reject(timeout) } as unknown as Response;
    await expect(readJsonObject(response)).rejects.toBe(timeout);
  });
});
