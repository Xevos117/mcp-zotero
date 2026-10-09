import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/*.test.ts"],
    setupFiles: ["src/__mocks__/setup.ts"],
    testTimeout: 10_000,
    hookTimeout: 10_000,
  },
});
