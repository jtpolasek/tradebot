import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { config as loadDotenv } from "dotenv";
import { resolve } from "path";
import { fileURLToPath } from "url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
loadDotenv({ path: resolve(__dirname, "../../../.env") });

const url = process.env["MIGRATE_URL"] ?? process.env["DATABASE_URL"];
if (!url) throw new Error("DATABASE_URL is not set");

const client = postgres(url, { max: 1 });
const db = drizzle(client);

const migrationsFolder = resolve(__dirname, "../drizzle");

await migrate(db, { migrationsFolder });
console.log("Migrations complete.");
await client.end();
