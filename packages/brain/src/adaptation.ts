export type FillRecord = {
  id: string;
  walletId: string | null;
  tokenAddress: string;
  side: "buy" | "sell";
  qty: number;
  entryPriceUsd: number;   // price_usd stored at fill time
  currentPriceUsd: number; // latest mark price (or entry if no mark)
  notionalUsd: number;
  liquidityUsd: number | null;
};

export type AdaptationLogEntry = {
  rule: string;
  oldValue: string;
  newValue: string;
  evidenceJson: unknown;
};

export type AdaptationDeps = {
  getCurrentMinLiquidityUsd: () => number;
  setMinLiquidityUsd: (value: number, evidence: unknown) => Promise<void>;
  logAdaptation: (entry: AdaptationLogEntry) => Promise<void>;
  getBuyFills: () => FillRecord[];
};

const LIQUIDITY_NOTCH_LEVELS = [150_000, 300_000, 500_000] as const;
const THRESHOLD_BOUNDARY = 300_000;
const MIN_FILLS_PER_BUCKET = 10;
const UNDERPERFORM_MARGIN_PCT = 5; // 5 percentage points

// Liquidity tiers for per-leader category filter
export const LIQUIDITY_TIERS = {
  major: 5_000_000,   // >= $5M
  mid: 500_000,       // >= $500k
  longtail: 0,        // < $500k
} as const;

export type LiquidityTier = "major" | "mid" | "longtail";

export function classifyLiquidityTier(liquidityUsd: number | null): LiquidityTier {
  if (liquidityUsd === null) return "longtail";
  if (liquidityUsd >= LIQUIDITY_TIERS.major) return "major";
  if (liquidityUsd >= LIQUIDITY_TIERS.mid) return "mid";
  return "longtail";
}

function computeReturn(fill: FillRecord): number {
  if (fill.entryPriceUsd <= 0) return 0;
  return ((fill.currentPriceUsd - fill.entryPriceUsd) / fill.entryPriceUsd) * 100;
}

export async function runLiquidityNotch(deps: AdaptationDeps): Promise<void> {
  const fills = deps.getBuyFills().filter((f) => f.liquidityUsd !== null);

  const below = fills.filter((f) => (f.liquidityUsd ?? 0) < THRESHOLD_BOUNDARY);
  const above = fills.filter((f) => (f.liquidityUsd ?? 0) >= THRESHOLD_BOUNDARY);

  if (below.length < MIN_FILLS_PER_BUCKET || above.length < MIN_FILLS_PER_BUCKET) return;

  const avgBelow = below.reduce((s, f) => s + computeReturn(f), 0) / below.length;
  const avgAbove = above.reduce((s, f) => s + computeReturn(f), 0) / above.length;

  const current = deps.getCurrentMinLiquidityUsd();
  const currentIdx = LIQUIDITY_NOTCH_LEVELS.indexOf(current as typeof LIQUIDITY_NOTCH_LEVELS[number]);

  if (avgBelow < avgAbove - UNDERPERFORM_MARGIN_PCT) {
    // Underperforming below boundary → raise notch
    const nextIdx = currentIdx >= 0 ? Math.min(currentIdx + 1, LIQUIDITY_NOTCH_LEVELS.length - 1) : 1;
    const nextLevel = LIQUIDITY_NOTCH_LEVELS[nextIdx]!;
    if (nextLevel !== current) {
      await deps.setMinLiquidityUsd(nextLevel, { avgBelow, avgAbove, belowCount: below.length, aboveCount: above.length });
      await deps.logAdaptation({
        rule: "liquidity-notch-raise",
        oldValue: String(current),
        newValue: String(nextLevel),
        evidenceJson: { avgBelow, avgAbove, belowCount: below.length, aboveCount: above.length },
      });
    }
  } else if (avgBelow >= avgAbove + UNDERPERFORM_MARGIN_PCT) {
    // Performing equally or better → consider lowering notch
    const prevIdx = currentIdx > 0 ? currentIdx - 1 : 0;
    const prevLevel = LIQUIDITY_NOTCH_LEVELS[prevIdx]!;
    if (prevLevel !== current) {
      await deps.setMinLiquidityUsd(prevLevel, { avgBelow, avgAbove, belowCount: below.length, aboveCount: above.length });
      await deps.logAdaptation({
        rule: "liquidity-notch-lower",
        oldValue: String(current),
        newValue: String(prevLevel),
        evidenceJson: { avgBelow, avgAbove, belowCount: below.length, aboveCount: above.length },
      });
    }
  }
}

export type PerLeaderMuteResult = Map<string, Set<LiquidityTier>>;

/**
 * Returns a map of walletId → set of tiers to mute for that leader.
 * A leader is muted in a tier if they have ≥ MIN_FILLS_PER_BUCKET fills in that tier
 * and ALL of them lost money.
 */
export function computePerLeaderMutes(fills: FillRecord[]): PerLeaderMuteResult {
  const result: PerLeaderMuteResult = new Map();

  // Group by walletId + tier
  const groups = new Map<string, FillRecord[]>();
  for (const fill of fills) {
    if (!fill.walletId) continue;
    const tier = classifyLiquidityTier(fill.liquidityUsd);
    const key = `${fill.walletId}:${tier}`;
    const arr = groups.get(key) ?? [];
    arr.push(fill);
    groups.set(key, arr);
  }

  for (const [key, tierFills] of groups) {
    if (tierFills.length < MIN_FILLS_PER_BUCKET) continue;
    const allLosing = tierFills.every((f) => computeReturn(f) < 0);
    if (allLosing) {
      const [walletId, tier] = key.split(":") as [string, LiquidityTier];
      const tiers = result.get(walletId) ?? new Set<LiquidityTier>();
      tiers.add(tier);
      result.set(walletId, tiers);
    }
  }

  return result;
}
