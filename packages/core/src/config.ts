import { z } from "zod";
import { config as loadDotenv } from "dotenv";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
loadDotenv({ path: resolve(__dirname, "../../../.env") });

const envBoolean = z.preprocess((value) => {
  if (typeof value !== "string") return value;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return value;
}, z.boolean());

const schema = z.object({
  DATABASE_URL: z.string().url(),
  TEST_DATABASE_URL: z.string().url().optional(),
  ALCHEMY_API_KEY: z.string().min(1),
  BASE_ALCHEMY_API_KEY: z.string().optional(),
  QUICKNODE_ETH_WS: z.string().optional(),
  QUICKNODE_BASE_WS: z.string().optional(),
  ZEROX_API_KEY: z.string().optional(),
  API_KEY: z.string().min(1),
  PAPER_STARTING_CASH_USD: z.coerce.number().positive().default(100_000),
  BASE_TRADE_PCT: z.coerce.number().positive().default(0.01),
  MAX_TRADE_PCT: z.coerce.number().positive().default(0.03),
  MIN_NOTIONAL_USD: z.coerce.number().positive().default(50),
  MIN_LIQUIDITY_USD: z.coerce.number().positive().default(150_000),
  MAX_SIGNAL_AGE_SEC: z.coerce.number().positive().default(180),
  COPY_DELAY_PENALTY_BPS_ETH: z.coerce.number().nonnegative().default(10),
  COPY_DELAY_PENALTY_BPS_BASE: z.coerce.number().nonnegative().default(5),
  GAS_USD_ETH: z.coerce.number().nonnegative().default(4),
  GAS_USD_BASE: z.coerce.number().nonnegative().default(0.03),
  SIZING_MODE: z.enum(["fixed", "proportional"]).default("fixed"),
  ALLOW_FALLBACK_PRICE_BUYS: envBoolean.default(false),
  MAX_SPOT_TWAP_DIVERGENCE_BPS: z.coerce.number().nonnegative().default(300),
  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).default("info"),
});

function parseConfig() {
  const result = schema.safeParse(process.env);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Config validation failed:\n${issues}`);
  }
  return result.data;
}

export const config = parseConfig();
export type Config = typeof config;
