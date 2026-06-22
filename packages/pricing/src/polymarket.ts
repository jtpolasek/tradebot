import { config, createLogger } from "@tradebot/core";
import { z } from "zod";

const logger = createLogger("pricing:polymarket");

const PRICE_TTL_MS = 5_000;
const MAX_POLYMARKET_CACHE_ENTRIES = 5_000;

const SharePriceSchema = z.union([z.number(), z.string()]).transform((value, ctx) => {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "share price must be a finite number between 0 and 1",
    });
    return z.NEVER;
  }
  return parsed;
});

const MarketPriceSchema = z.object({
  price: SharePriceSchema,
});

export type PolymarketExecutionSide = "buy" | "sell";

export type PolymarketPriceResult = {
  tokenId: string;
  side: PolymarketExecutionSide;
  source: "polymarket-clob";
  price: number;
  bestBid: number;
  bestAsk: number;
  spread: number;
  spreadBps: number | null;
  maxSpreadBps: number;
  fetchedAt: number;
};

export interface GetPolymarketPriceOptions {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  maxSpreadBps?: number;
}

type CachedQuote = {
  bestBid: number;
  bestAsk: number;
  fetchedAt: number;
};

const quoteCache = new Map<string, CachedQuote>();

function normalizeTokenId(tokenId: string): string {
  return tokenId.trim().toLowerCase();
}

function cacheKey(baseUrl: string, tokenId: string): string {
  return `${baseUrl.replace(/\/$/, "")}:${normalizeTokenId(tokenId)}`;
}

function cappedSet<K, V>(map: Map<K, V>, key: K, value: V): void {
  map.delete(key);
  map.set(key, value);
  if (map.size > MAX_POLYMARKET_CACHE_ENTRIES) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
}

function currentBaseUrl(opts: GetPolymarketPriceOptions): string {
  return opts.baseUrl ?? config.POLYMARKET_CLOB_API_URL;
}

function currentMaxSpreadBps(opts: GetPolymarketPriceOptions): number {
  return opts.maxSpreadBps ?? config.POLYMARKET_MAX_SPREAD_BPS;
}

function spreadBps(bestBid: number, bestAsk: number): number | null {
  const midpoint = (bestBid + bestAsk) / 2;
  if (!Number.isFinite(midpoint) || midpoint <= 0) return null;
  return ((bestAsk - bestBid) / midpoint) * 10_000;
}

async function fetchMarketPrice(
  baseUrl: string,
  tokenId: string,
  side: "BUY" | "SELL",
  fetchImpl: typeof fetch,
): Promise<number> {
  const url = `${baseUrl.replace(/\/$/, "")}/price?${new URLSearchParams({
    token_id: tokenId,
    side,
  }).toString()}`;

  const res = await fetchImpl(url);
  if (!res.ok) {
    throw new Error(`Polymarket CLOB /price ${res.status} for token ${tokenId} side ${side}`);
  }

  const json: unknown = await res.json();
  return MarketPriceSchema.parse(json).price;
}

async function readQuote(
  tokenId: string,
  opts: GetPolymarketPriceOptions = {},
): Promise<CachedQuote> {
  const baseUrl = currentBaseUrl(opts);
  const key = cacheKey(baseUrl, tokenId);
  const cached = quoteCache.get(key);
  if (cached && Date.now() - cached.fetchedAt < PRICE_TTL_MS) return cached;

  const fetchImpl = opts.fetchImpl ?? fetch;
  // Read both documented `/price` sides and infer bid/ask from lower/higher. This keeps the wrapper
  // stable even if the endpoint-side wording changes, while still using the official public API.
  const [buySidePrice, sellSidePrice] = await Promise.all([
    fetchMarketPrice(baseUrl, tokenId, "BUY", fetchImpl),
    fetchMarketPrice(baseUrl, tokenId, "SELL", fetchImpl),
  ]);

  const quote = {
    bestBid: Math.min(buySidePrice, sellSidePrice),
    bestAsk: Math.max(buySidePrice, sellSidePrice),
    fetchedAt: Date.now(),
  };
  cappedSet(quoteCache, key, quote);
  return quote;
}

export async function getPolymarketPrice(
  tokenId: string,
  side: PolymarketExecutionSide,
  opts: GetPolymarketPriceOptions = {},
): Promise<PolymarketPriceResult | null> {
  const normalizedTokenId = normalizeTokenId(tokenId);
  try {
    const quote = await readQuote(normalizedTokenId, opts);
    const price = side === "buy" ? quote.bestAsk : quote.bestBid;
    return {
      tokenId: normalizedTokenId,
      side,
      source: "polymarket-clob",
      price,
      bestBid: quote.bestBid,
      bestAsk: quote.bestAsk,
      spread: quote.bestAsk - quote.bestBid,
      spreadBps: spreadBps(quote.bestBid, quote.bestAsk),
      maxSpreadBps: currentMaxSpreadBps(opts),
      fetchedAt: quote.fetchedAt,
    };
  } catch (err) {
    logger.warn({ err, tokenId: normalizedTokenId, side }, "Polymarket CLOB price lookup failed");
    return null;
  }
}

export function clearPolymarketPriceCache(): void {
  quoteCache.clear();
}

/** Test-only probe of the bounded per-token quote cache size. */
export function __polymarketCacheSize(): number {
  return quoteCache.size;
}

