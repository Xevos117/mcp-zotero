#!/usr/bin/env node
// Cleanup of interrupted or given live runs, with the same marker checks as the suite's teardown:
//   npm run test:live:cleanup -- [runId ...]
// Without arguments it cleans the runs that left a marker or a registry in .vitest/. Uses the same env
// as the suite (ZOTERO_TEST_API_KEY, ZOTERO_LIVE_SAFE_MODE=1 for a personal library, ...).
import { spawnSync } from "node:child_process";

const ids = process.argv.slice(2).filter(Boolean);
const r = spawnSync(process.execPath, ["node_modules/vitest/vitest.mjs", "run", "--config", "vitest.live.config.ts"], {
  stdio: "inherit",
  timeout: 10 * 60 * 1000,
  env: { ...process.env, ZOTERO_LIVE_CLEANUP_ONLY: "1", ...(ids.length ? { ZOTERO_LIVE_CLEANUP_RUN_IDS: ids.join(",") } : {}) },
});
if (r.error) console.error(`test:live:cleanup: ${r.error.message}`);
process.exit(r.status ?? 1);
