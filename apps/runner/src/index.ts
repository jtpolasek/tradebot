import { config, createLogger } from "@tradebot/core";
import { getDb, closeDb } from "@tradebot/store";
import postgres from "postgres";

const logger = createLogger("runner");

async function main() {
  logger.info("Starting tradebot runner...");

  // Simple connectivity check before handing off to drizzle
  const pg = postgres(config.DATABASE_URL, { max: 1 });
  await pg`select 1`;
  await pg.end();
  getDb(config.DATABASE_URL);
  logger.info("Database connection ok.");

  logger.info("Runner ready.");

  process.once("SIGINT", async () => {
    logger.info("Shutting down...");
    await closeDb();
    process.exit(0);
  });

  process.once("SIGTERM", async () => {
    logger.info("Shutting down...");
    await closeDb();
    process.exit(0);
  });
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
