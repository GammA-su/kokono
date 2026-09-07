import { defineConfig } from "vitest/config";
import { config } from "dotenv";

config({ quiet: true });

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    globalSetup: ["./tests/global-setup.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    fileParallelism: false,
  },
});
