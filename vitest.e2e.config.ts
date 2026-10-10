import { defineConfig } from "vitest/config";

// Suite e2e separata: avvia build/server.js su stdio (vedi test/e2e).
// Eseguire con `npm run test:e2e` (compila prima il server).
export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["test/e2e/**/*.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    teardownTimeout: 15_000,
    fileParallelism: false,
  },
});
