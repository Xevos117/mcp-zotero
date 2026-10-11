import { defineConfig } from "vitest/config";

// Suite dal vivo contro un account Zotero reale (vedi test/live/global-setup.ts e test/TEST_CASES.md, LIVE-*).
// Si attiva solo con ZOTERO_TEST_API_KEY; eseguire con `npm run test:live` (compila prima il server).
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/live/**/*.live.test.ts"],
    globalSetup: ["test/live/global-setup.ts"],
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 300_000,
    teardownTimeout: 30_000,
    reporters: ["default", ["json", { outputFile: ".vitest/live-report.json" }]],
  },
});
