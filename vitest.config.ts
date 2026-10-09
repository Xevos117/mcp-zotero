import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/.git/**", "test/e2e/**"],
    setupFiles: ["src/__mocks__/setup.ts"],
    testTimeout: 15_000,
    hookTimeout: 15_000,
    teardownTimeout: 10_000,
  },
});
