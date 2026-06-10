import { eq, and } from "drizzle-orm";
import type { Db } from "../db.js";
import { tokens } from "../schema.js";
import type { ChainId } from "@tradebot/core";

export type TokenRow = {
  chain: ChainId;
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  isBlocked: boolean;
};

export async function getToken(db: Db, chain: ChainId, address: string): Promise<TokenRow | null> {
  const rows = await db
    .select()
    .from(tokens)
    .where(and(eq(tokens.chain, chain), eq(tokens.address, address.toLowerCase())));
  const row = rows[0];
  if (!row) return null;
  return rowToToken(row);
}

export async function upsertToken(db: Db, token: TokenRow): Promise<void> {
  await db
    .insert(tokens)
    .values({
      chain: token.chain,
      address: token.address.toLowerCase(),
      symbol: token.symbol,
      name: token.name,
      decimals: token.decimals,
    })
    .onConflictDoNothing();
}

function rowToToken(row: typeof tokens.$inferSelect): TokenRow {
  return {
    chain: row.chain as ChainId,
    address: row.address,
    symbol: row.symbol,
    name: row.name,
    decimals: row.decimals,
    isBlocked: row.isBlocked,
  };
}
