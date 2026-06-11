import { eq } from "drizzle-orm";
import type { Db } from "../db.js";
import { settings } from "../schema.js";

export async function getSetting(db: Db, key: string): Promise<unknown | null> {
  const rows = await db.select().from(settings).where(eq(settings.key, key)).limit(1);
  return rows[0]?.value ?? null;
}

export async function setSetting(db: Db, key: string, value: unknown): Promise<void> {
  await db.insert(settings).values({
    key,
    value,
    updatedAt: new Date(),
  }).onConflictDoUpdate({
    target: settings.key,
    set: { value, updatedAt: new Date() },
  });
}

export async function deleteSetting(db: Db, key: string): Promise<void> {
  await db.delete(settings).where(eq(settings.key, key));
}

export async function getAllSettings(db: Db): Promise<Record<string, unknown>> {
  const rows = await db.select().from(settings);
  const out: Record<string, unknown> = {};
  for (const row of rows) {
    out[row.key] = row.value;
  }
  return out;
}
