import { defineConfig } from "vitest/config";
import { config as loadDotenv } from "dotenv";
import { resolve } from "path";
import { fileURLToPath } from "url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
loadDotenv({ path: resolve(__dirname, "../../.env") });

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    testTimeout: 30_000,
    // These suites share one Postgres test DB and truncate tables in beforeEach, so files must
    // run serially — parallel files would see each other's rows mid-test.
    fileParallelism: false,
    env: {
      TEST_DATABASE_URL: process.env["TEST_DATABASE_URL"] ?? "",
    },
  },
});
