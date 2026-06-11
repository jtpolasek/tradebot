import { defineConfig } from "vitest/config";
export default defineConfig({ test: { include: ["src/**/*.test.ts", "src/**/*.test.tsx"], testTimeout: 10_000 } });
