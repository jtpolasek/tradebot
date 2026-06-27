import { config, createLogger } from "@tradebot/core";
import { z } from "zod";

const logger = createLogger("pricing:polymarket");

const PRICE_TTL_MS = 5_000;
const MARKET_STATUS_TTL_MS = 30_000;
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

export type PolymarketMarketStatus = {
  conditionId: string;
  source: "polymarket-gamma";
  fetchedAt: number;
  active: boolean | null;
  closed: boolean;
  resolved: boolean;
  acceptingOrders: boolean | null;
  outcomes: string[] | null;
  outcomePrices: number[] | null;
  clobTokenIds: string[] | null;
};

export interface GetPolymarketMarketStatusOptions {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

type CachedQuote = {
  bestBid: number;
  bestAsk: number;
  fetchedAt: number;
};

type CachedMarketStatus = PolymarketMarketStatus;

const GammaBooleanSchema = z.union([z.boolean(), z.number(), z.string()]).transform((value, ctx) => {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (value === 1) return true;
    if (value === 0) return false;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(normalized)) return true;
    if (["0", "false", "no", "off"].includes(normalized)) return false;
  }
  ctx.addIssue({
    code: z.ZodIssueCode.custom,
    message: "expected a boolean-like value",
  });
  return z.NEVER;
});

const GammaMarketSchema = z.object({
  conditionId: z.string().optional(),
  condition_id: z.string().optional(),
  active: GammaBooleanSchema.optional(),
  closed: GammaBooleanSchema.optional(),
  resolved: GammaBooleanSchema.optional(),
  acceptingOrders: GammaBooleanSchema.optional(),
  accepting_orders: GammaBooleanSchema.optional(),
  outcomes: z.unknown().optional(),
  outcomePrices: z.unknown().optional(),
  outcome_prices: z.unknown().optional(),
  clobTokenIds: z.unknown().optional(),
  clob_token_ids: z.unknown().optional(),
}).passthrough();

const quoteCache = new Map<string, CachedQuote>();
const marketStatusCache = new Map<string, CachedMarketStatus>();

function normalizeTokenId(tokenId: string): string {
  return tokenId.trim().toLowerCase();
}

function normalizeConditionId(conditionId: string): string {
  return conditionId.trim().toLowerCase();
}

function cacheKey(baseUrl: string, id: string): string {
  return `${baseUrl.replace(/\/$/, "")}:${id}`;
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

function currentGammaBaseUrl(opts: GetPolymarketMarketStatusOptions): string {
  return opts.baseUrl ?? config.POLYMARKET_GAMMA_API_URL;
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
  const key = cacheKey(baseUrl, normalizeTokenId(tokenId));
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

async function fetchGammaMarket(
  baseUrl: string,
  conditionId: string,
  fetchImpl: typeof fetch,
): Promise<z.infer<typeof GammaMarketSchema>[]> {
  const endpoint = `${baseUrl.replace(/\/$/, "")}/markets`;
  const queries = [
    new URLSearchParams({ condition_id: conditionId }),
    new URLSearchParams({ conditionId }),
  ];

  let lastStatus = 0;
  for (const query of queries) {
    const res = await fetchImpl(`${endpoint}?${query.toString()}`);
    lastStatus = res.status;
    if (!res.ok) continue;
    const json: unknown = await res.json();
    const parsed = parseGammaMarkets(json);
    if (parsed.length > 0) return parsed;
  }

  throw new Error(`Polymarket Gamma /markets ${lastStatus} for condition ${conditionId}`);
}

async function fetchGammaEventMarkets(
  baseUrl: string,
  eventSlug: string,
  fetchImpl: typeof fetch,
): Promise<z.infer<typeof GammaMarketSchema>[]> {
  const endpoint = `${baseUrl.replace(/\/$/, "")}/events`;
  const query = new URLSearchParams({ slug: eventSlug });
  const res = await fetchImpl(`${endpoint}?${query.toString()}`);
  if (!res.ok) throw new Error(`Polymarket Gamma /events ${res.status} for slug ${eventSlug}`);
  const json: unknown = await res.json();
  if (Array.isArray(json)) {
    const event = json[0] as Record<string, unknown> | undefined;
    return parseGammaEventMarkets(event);
  }
  if (json && typeof json === "object") {
    const obj = json as Record<string, unknown>;
    if (Array.isArray(obj["data"])) return parseGammaEventMarkets(obj["data"][0] as Record<string, unknown> | undefined);
    return parseGammaEventMarkets(obj);
  }
  throw new Error("Polymarket Gamma /events returned an unexpected payload shape");
}

function parseGammaMarkets(json: unknown): z.infer<typeof GammaMarketSchema>[] {
  if (Array.isArray(json)) return z.array(GammaMarketSchema).parse(json);
  if (json && typeof json === "object") {
    const obj = json as Record<string, unknown>;
    if (Array.isArray(obj["data"])) return z.array(GammaMarketSchema).parse(obj["data"]);
    return [GammaMarketSchema.parse(obj)];
  }
  throw new Error("Polymarket Gamma /markets returned an unexpected payload shape");
}

function parseGammaEventMarkets(event: Record<string, unknown> | undefined): z.infer<typeof GammaMarketSchema>[] {
  const markets = event?.["markets"];
  if (!Array.isArray(markets)) return [];
  return z.array(GammaMarketSchema).parse(markets);
}

function normalizeMarketStatus(
  conditionId: string,
  market: z.infer<typeof GammaMarketSchema>,
  fetchedAt: number,
): PolymarketMarketStatus {
  const active = market.active ?? null;
  const closed = market.closed ?? (active === false);
  const resolved = market.resolved ?? false;
  const acceptingOrders = market.acceptingOrders ?? market.accepting_orders ?? null;
  return {
    conditionId,
    source: "polymarket-gamma",
    fetchedAt,
    active,
    closed,
    resolved,
    acceptingOrders,
    outcomes: parseStringArrayField(market.outcomes),
    outcomePrices: parseNumberArrayField(market.outcomePrices ?? market.outcome_prices),
    clobTokenIds: parseStringArrayField(market.clobTokenIds ?? market.clob_token_ids),
  };
}

function parseStringArrayField(value: unknown): string[] | null {
  const parsed = parseArrayField(value);
  if (!parsed) return null;
  const normalized = parsed
    .map((item) => (typeof item === "string" ? item.trim() : String(item)))
    .filter((item) => item.length > 0);
  return normalized.length > 0 ? normalized : null;
}

function parseNumberArrayField(value: unknown): number[] | null {
  const parsed = parseArrayField(value);
  if (!parsed) return null;
  const normalized = parsed
    .map((item) => (typeof item === "number" ? item : Number(item)))
    .filter((item) => Number.isFinite(item));
  return normalized.length > 0 ? normalized : null;
}

function parseArrayField(value: unknown): unknown[] | null {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
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

export async function getPolymarketMarketStatus(
  conditionId: string,
  opts: GetPolymarketMarketStatusOptions = {},
): Promise<PolymarketMarketStatus | null> {
  const normalizedConditionId = normalizeConditionId(conditionId);
  try {
    const baseUrl = currentGammaBaseUrl(opts);
    const key = cacheKey(baseUrl, normalizedConditionId);
    const cached = marketStatusCache.get(key);
    if (cached && Date.now() - cached.fetchedAt < MARKET_STATUS_TTL_MS) return cached;

    const fetchImpl = opts.fetchImpl ?? fetch;
    const markets = await fetchGammaMarket(baseUrl, normalizedConditionId, fetchImpl);
    const matching = markets.find((market) => normalizeConditionId(market.conditionId ?? market.condition_id ?? "") === normalizedConditionId);
    if (!matching) return null;

    const normalized = normalizeMarketStatus(normalizedConditionId, matching, Date.now());
    cappedSet(marketStatusCache, key, normalized);
    return normalized;
  } catch (err) {
    logger.warn({ err, conditionId: normalizedConditionId }, "Polymarket Gamma market-status lookup failed");
    return null;
  }
}

export async function getPolymarketMarketStatusByEventSlug(
  conditionId: string,
  eventSlug: string,
  opts: GetPolymarketMarketStatusOptions = {},
): Promise<PolymarketMarketStatus | null> {
  const normalizedConditionId = normalizeConditionId(conditionId);
  const normalizedSlug = eventSlug.trim();
  if (!normalizedSlug) return null;
  try {
    const baseUrl = currentGammaBaseUrl(opts);
    const key = cacheKey(baseUrl, `${normalizedConditionId}:event:${normalizedSlug}`);
    const cached = marketStatusCache.get(key);
    if (cached && Date.now() - cached.fetchedAt < MARKET_STATUS_TTL_MS) return cached;

    const fetchImpl = opts.fetchImpl ?? fetch;
    const markets = await fetchGammaEventMarkets(baseUrl, normalizedSlug, fetchImpl);
    const matching = markets.find((market) => normalizeConditionId(market.conditionId ?? market.condition_id ?? "") === normalizedConditionId);
    if (!matching) return null;

    const normalized = normalizeMarketStatus(normalizedConditionId, matching, Date.now());
    cappedSet(marketStatusCache, key, normalized);
    return normalized;
  } catch (err) {
    logger.warn({ err, conditionId: normalizedConditionId, eventSlug: normalizedSlug }, "Polymarket Gamma event-status lookup failed");
    return null;
  }
}

export function clearPolymarketPriceCache(): void {
  quoteCache.clear();
  marketStatusCache.clear();
}

/**
 * Resolution payout for one outcome index. Gamma's live `/markets` payload currently exposes
 * terminal prices via `outcomePrices` rather than a dedicated winner field, so the settler treats a
 * closed/resolved market as settleable only when the relevant outcome is clearly 1 or 0.
 */
export function getPolymarketResolutionPayout(
  status: Pick<PolymarketMarketStatus, "closed" | "resolved" | "outcomePrices">,
  outcomeIndex: number,
): 0 | 1 | null {
  if (!Number.isInteger(outcomeIndex) || outcomeIndex < 0) return null;
  if (!status.closed && !status.resolved) return null;
  const price = status.outcomePrices?.[outcomeIndex];
  if (price === undefined || !Number.isFinite(price)) return null;
  if (price >= 0.99) return 1;
  if (price <= 0.01) return 0;
  return null;
}

/** Test-only probe of the bounded per-token quote cache size. */
export function __polymarketCacheSize(): number {
  return quoteCache.size;
}

/** Test-only probe of the bounded per-condition market-status cache size. */
export function __polymarketMarketStatusCacheSize(): number {
  return marketStatusCache.size;
}
