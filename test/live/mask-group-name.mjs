#!/usr/bin/env node
// Masks the name of the Zotero test group in a GitHub Actions job. Run it as the first step of every job that
// talks to the test account: it reads the name from the Web API with the test key (in-process, never printed),
// registers it with `::add-mask::` (GitHub then hides it in every later log line of the job) and exports it as
// ZOTERO_TEST_GROUP_NAME through $GITHUB_ENV, for the fail-closed checks of scrub-report.mjs, redact.mjs and
// agent/summary.mjs. Without ZOTERO_TEST_GROUP_ID there is no group: nothing to do.
// Exit 1, without the name in the message, if the group is configured but its name cannot be read: the later
// checks would otherwise pass without it.
// Usage: ZOTERO_TEST_API_KEY=... ZOTERO_TEST_GROUP_ID=... node test/live/mask-group-name.mjs
import { appendFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";

const REQUEST_TIMEOUT_MS = 20_000;
const ATTEMPTS = 3;

const RETRY = new Set([429, 500, 502, 503, 504]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Name of the group, read with the test key; errors never contain it. */
export async function groupName(groupId, key, fetchImpl = fetch, delayMs = 1000) {
  for (let attempt = 1; ; attempt++) {
    let res;
    try {
      res = await fetchImpl(`https://api.zotero.org/groups/${groupId}`, {
        headers: { "Zotero-API-Key": key, "Zotero-API-Version": "3" },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (e) {
      if (attempt >= ATTEMPTS) throw new Error(`cannot read the test group (${e instanceof Error ? e.name : "network error"})`);
      await sleep(delayMs * attempt);
      continue;
    }
    if (res.ok) {
      const name = (await res.json().catch(() => null))?.data?.name;
      if (typeof name === "string" && name.trim()) return name.trim();
      throw new Error("cannot read the test group (no name in the API response)");
    }
    if (!RETRY.has(res.status) || attempt >= ATTEMPTS) throw new Error(`cannot read the test group (HTTP ${res.status})`);
    await sleep(delayMs * attempt);
  }
}

/** Lines to write: the mask command for stdout and the multiline-safe $GITHUB_ENV entry. */
export function maskOutput(name, delimiter = `MZT_${randomBytes(8).toString("hex")}`) {
  if (/[\r\n]/.test(name)) throw new Error("group name with a line break");
  return { stdout: `::add-mask::${name}\n`, env: `ZOTERO_TEST_GROUP_NAME<<${delimiter}\n${name}\n${delimiter}\n` };
}

async function main() {
  const groupId = (process.env.ZOTERO_TEST_GROUP_ID ?? "").trim();
  if (!groupId) {
    console.log("mask-group-name: no test group configured");
    return 0;
  }
  if (!/^\d+$/.test(groupId)) throw new Error("ZOTERO_TEST_GROUP_ID is not numeric");
  const key = process.env.ZOTERO_TEST_API_KEY ?? "";
  if (!key) throw new Error("ZOTERO_TEST_API_KEY missing");
  const out = maskOutput(await groupName(groupId, key));
  process.stdout.write(out.stdout);
  if (process.env.GITHUB_ENV) appendFileSync(process.env.GITHUB_ENV, out.env);
  console.log("mask-group-name: test group name masked");
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().then(
    (code) => process.exit(code),
    (e) => {
      console.error(`mask-group-name: ${e instanceof Error ? e.message : String(e)}`);
      process.exit(1);
    }
  );
}
