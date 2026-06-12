import { config as loadDotenv } from "dotenv";
import { resolve } from "path";
import { fileURLToPath } from "url";
import { z } from "zod";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
loadDotenv({ path: resolve(__dirname, "../../../.env") });

const ApiConfigSchema = z.object({
  API_KEY: z.string().min(1),
  API_PORT: z.coerce.number().int().positive().default(3001),
  CORS_ORIGIN: z.string().url().default("http://localhost:3000"),
  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).default("info"),
});

export const apiConfig = ApiConfigSchema.parse(process.env);
export type ApiConfig = typeof apiConfig;
