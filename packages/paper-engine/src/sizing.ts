const CASH_ASSET_SYMBOLS = new Set(["USDC", "USDT", "DAI"]);
const NATIVE_ASSET_SYMBOLS = new Set(["ETH", "WETH"]);

export type SizingCandidate = {
  side: "buy" | "sell";
  tokenInSymbol: string;
  tokenInAddress: string;
  tokenInAmountHuman: number;
  tokenOutSymbol: string;
  tokenOutAddress: string;
  tokenOutAmountHuman: number;
};

export type SizingSettings = {
  mode: "fixed" | "proportional";
  /** For fixed mode: the USD amount to spend per trade */
  fixedUsd: number;
  /** For proportional mode: percentage of leader's source notional to copy (0-100) */
  percentOfSource: number;
  maxTradeUsd: number;
  blocklist: string[];
  allowlist: string[];
};

export type SizingPosition = {
  quantity: number;
  averageEntryUsd: number;
};

export function estimateSourceNotionalUsd(candidate: SizingCandidate, nativeUsd: number): number {
  const inputSymbol = candidate.tokenInSymbol.trim().toUpperCase();
  const outputSymbol = candidate.tokenOutSymbol.trim().toUpperCase();

  if (candidate.side === "buy") {
    if (CASH_ASSET_SYMBOLS.has(inputSymbol)) return candidate.tokenInAmountHuman;
    if (NATIVE_ASSET_SYMBOLS.has(inputSymbol)) return candidate.tokenInAmountHuman * nativeUsd;
  }

  if (candidate.side === "sell") {
    if (CASH_ASSET_SYMBOLS.has(outputSymbol)) return candidate.tokenOutAmountHuman;
    if (NATIVE_ASSET_SYMBOLS.has(outputSymbol)) return candidate.tokenOutAmountHuman * nativeUsd;
  }

  return 0;
}

function assertTokenAllowed(candidate: SizingCandidate, settings: SizingSettings): void {
  const tokenAddress =
    candidate.side === "buy"
      ? candidate.tokenOutAddress.toLowerCase()
      : candidate.tokenInAddress.toLowerCase();

  if (settings.allowlist.length && !settings.allowlist.includes(tokenAddress)) {
    throw new Error("This token is not on the copy allowlist.");
  }
  if (settings.blocklist.includes(tokenAddress)) {
    throw new Error("This token is on the copy blocklist.");
  }
}

export function sizeCopyTrade(input: {
  candidate: SizingCandidate;
  settings: SizingSettings;
  nativeUsd: number;
  position: SizingPosition | null;
}): { side: "buy"; tokenAddress: string; usdAmount: number; sourceNotionalUsd: number }
 | { side: "sell"; tokenAddress: string; tokenQuantity: number; sourceNotionalUsd: number } {
  const { candidate, settings, nativeUsd, position } = input;

  if (candidate.side !== "buy" && candidate.side !== "sell") {
    throw new Error("Only buy or sell candidates can be copied.");
  }

  assertTokenAllowed(candidate, settings);
  const sourceNotionalUsd = estimateSourceNotionalUsd(candidate, nativeUsd);

  const desiredUsd =
    settings.mode === "fixed"
      ? settings.fixedUsd
      : sourceNotionalUsd * (settings.percentOfSource / 100);
  const cappedUsd = Math.min(desiredUsd, settings.maxTradeUsd);

  if (!Number.isFinite(cappedUsd) || cappedUsd <= 0) {
    throw new Error("Could not determine a positive copy size for this candidate.");
  }

  if (candidate.side === "buy") {
    return {
      side: "buy",
      tokenAddress: candidate.tokenOutAddress,
      usdAmount: cappedUsd,
      sourceNotionalUsd,
    };
  }

  if (!position || position.quantity <= 0) {
    throw new Error("This sell candidate cannot be copied because the paper portfolio has no matching position.");
  }

  const sourceQuantity = candidate.tokenInAmountHuman;
  const desiredQuantity =
    settings.mode === "fixed"
      ? cappedUsd / Math.max(position.averageEntryUsd, 1e-10)
      : sourceQuantity * (settings.percentOfSource / 100);
  const maxQuantityByCap = settings.maxTradeUsd / Math.max(position.averageEntryUsd, 1e-10);
  const tokenQuantity = Math.min(desiredQuantity, maxQuantityByCap, position.quantity);

  if (!Number.isFinite(tokenQuantity) || tokenQuantity <= 0) {
    throw new Error("Could not determine a positive sell quantity for this candidate.");
  }

  return {
    side: "sell",
    tokenAddress: candidate.tokenInAddress,
    tokenQuantity,
    sourceNotionalUsd,
  };
}

export function calculateCashCappedBuyUsd(input: {
  cashUsd: number;
  requestedUsd: number;
  gasUsd: number;
  dexFeeUsd: number;
  slippageBps: number;
  safetyBufferBps?: number;
}): number {
  const safetyBufferBps = input.safetyBufferBps ?? 25;
  const fixedFeesUsd = Math.max(0, input.gasUsd) + Math.max(0, input.dexFeeUsd);
  const spendableBeforeSlippage = input.cashUsd - fixedFeesUsd;
  if (!Number.isFinite(spendableBeforeSlippage) || spendableBeforeSlippage <= 0) return 0;

  const slippageMultiplier = 1 + Math.max(0, input.slippageBps) / 10_000;
  const bufferedUsd = (spendableBeforeSlippage / slippageMultiplier) * (1 - safetyBufferBps / 10_000);
  if (!Number.isFinite(bufferedUsd) || bufferedUsd <= 0) return 0;
  return Math.min(input.requestedUsd, bufferedUsd);
}
