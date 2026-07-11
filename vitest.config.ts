import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: false,
    pool: "forks",
    fileParallelism: false,
    exclude: ["dist/**", "node_modules/**"],
    coverage: {
      reporter: ["text", "json-summary"]
    }
  }
});
