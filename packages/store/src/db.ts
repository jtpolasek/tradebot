import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.js";

let _client: ReturnType<typeof postgres> | undefined;
let _db: ReturnType<typeof drizzle<typeof schema>> | undefined;
let _dbUrl: string | undefined;

export function getDb(url?: string) {
  const dbUrl = url ?? process.env["DATABASE_URL"];
  if (!dbUrl) throw new Error("DATABASE_URL is not set");
  if (_db && _dbUrl !== dbUrl) {
    throw new Error("getDb called with a different URL after initialization; call closeDb() before switching databases");
  }
  if (!_db) {
    _client = postgres(dbUrl);
    _db = drizzle(_client, { schema });
    _dbUrl = dbUrl;
  }
  return _db;
}

export async function closeDb() {
  if (_client) {
    await _client.end();
    _client = undefined;
    _db = undefined;
    _dbUrl = undefined;
  }
}

export type Db = ReturnType<typeof getDb>;
