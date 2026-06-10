import type { NormalizedTransfer, BalanceDeltaResult } from "./types.js";

const STABLE_OR_NATIVE_ASSETS = new Set(["ETH", "WETH", "USDC", "USDT", "DAI", "CBBTC"]);

type TradeSide = "buy" | "sell";
type TransferPair = {
  tokenIn: NormalizedTransfer;
  tokenOut: NormalizedTransfer;
  side: TradeSide | "unknown";
  score: number;
};
type PairAnalysis = {
  viablePairs: TransferPair[];
  sideCount: number;
  buyCopyTokenCount: number;
  sellCopyTokenCount: number;
};

export function analyzePairs(
  outbound: NormalizedTransfer[],
  inbound: NormalizedTransfer[]
): BalanceDeltaResult {
  const pairAnalysis = buildPairAnalysis(outbound, inbound);
  const hasMixedSideShapes = pairAnalysis.sideCount > 1;
  const selectedPair = hasMixedSideShapes
    ? selectBestPairForSide(pairAnalysis.viablePairs, "buy") ?? pairAnalysis.viablePairs[0] ?? null
    : pairAnalysis.viablePairs[0] ?? null;
  const tokenIn = selectedPair?.tokenIn ?? largestTransfer(outbound);
  const tokenOut = selectedPair?.tokenOut ?? largestTransfer(inbound);
  const hasBothDirections = Boolean(tokenIn && tokenOut);
  const viablePairCount = pairAnalysis.viablePairs.length;
  const selectedSide = selectedPair?.side ?? inferSide(tokenIn?.symbol, tokenOut?.symbol);
  const side = hasMixedSideShapes ? "unknown" : selectedSide;
  const tokenToCopy = side === "buy" ? tokenOut : side === "sell" ? tokenIn : null;
  const missingCopyTokenAddress = Boolean(tokenToCopy && !tokenToCopy.tokenAddress);
  const hasMultipleCopyTokens =
    selectedSide === "buy"
      ? pairAnalysis.buyCopyTokenCount > 1
      : selectedSide === "sell"
      ? pairAnalysis.sellCopyTokenCount > 1
      : false;
  const isAmbiguous = inbound.length > 1 || outbound.length > 1 || viablePairCount > 1;
  const hasOnlyTinyTransferNoise = selectedPair
    ? isTinyTransferNoise({ selected: selectedPair, viablePairs: pairAnalysis.viablePairs, inbound, outbound })
    : false;
  const needsReview = (isAmbiguous && !hasOnlyTinyTransferNoise) || missingCopyTokenAddress;

  if (!hasBothDirections) {
    return {
      status: "skipped",
      confidence: 0,
      side: "unknown",
      tokenIn: tokenIn ?? null,
      tokenOut: tokenOut ?? null,
      reason: "No paired inbound and outbound wallet transfers were found for this transaction.",
    };
  }

  if (side === "unknown") {
    const reason =
      hasMixedSideShapes
        ? "Transfers include plausible buy and sell shapes in the same transaction. Review on the block explorer before copying."
        : hasMissingTokenDetails(tokenIn) || hasMissingTokenDetails(tokenOut)
        ? "Alchemy returned a paired transfer with missing token symbol, amount, or contract address. Review on the block explorer before copying."
        : "Transfers are paired, but the buy/sell side could not be inferred from common cash/native assets.";

    return {
      status: "candidate",
      confidence: hasMixedSideShapes ? 0.4 : isAmbiguous ? 0.45 : 0.6,
      side,
      tokenIn: tokenIn ?? null,
      tokenOut: tokenOut ?? null,
      reason,
    };
  }

  return {
    status: needsReview ? "candidate" : "decoded",
    confidence: missingCopyTokenAddress ? 0.58 : hasMultipleCopyTokens ? 0.52 : needsReview ? 0.72 : 0.9,
    side,
    tokenIn: tokenIn ?? null,
    tokenOut: tokenOut ?? null,
    reason: missingCopyTokenAddress
      ? "The likely traded token has no contract address in the transfer payload; review before copying."
      : hasMultipleCopyTokens
      ? describeMultipleCopyTokens(selectedSide, tokenIn?.symbol ?? "", tokenOut?.symbol ?? "")
      : needsReview
      ? describeAmbiguousPair(side, tokenIn?.symbol ?? "", tokenOut?.symbol ?? "")
      : describeDecodedPair(side, tokenIn?.symbol ?? "", tokenOut?.symbol ?? ""),
  };
}

function largestTransfer(items: NormalizedTransfer[]) {
  return [...items].sort((a, b) => b.amountHuman - a.amountHuman)[0] ?? null;
}

function buildPairAnalysis(outbound: NormalizedTransfer[], inbound: NormalizedTransfer[]): PairAnalysis {
  const pairs = outbound.flatMap((tokenIn) =>
    inbound.map((tokenOut) => {
      const side = inferSide(tokenIn.symbol, tokenOut.symbol);
      return { tokenIn, tokenOut, side, score: scorePair(tokenIn, tokenOut, side) };
    })
  );
  const viable = pairs.filter((pair) => pair.score > 0).sort((a, b) => b.score - a.score);
  return {
    viablePairs: viable,
    sideCount: new Set(viable.map((pair) => pair.side)).size,
    buyCopyTokenCount: countDistinctCopyTokens(viable, "buy"),
    sellCopyTokenCount: countDistinctCopyTokens(viable, "sell"),
  };
}

function selectBestPairForSide(pairs: TransferPair[], side: TradeSide) {
  return pairs.find((pair) => pair.side === side) ?? null;
}

function countDistinctCopyTokens(pairs: TransferPair[], side: TradeSide) {
  return new Set(
    pairs
      .filter((pair) => pair.side === side)
      .map((pair) => (side === "buy" ? pair.tokenOut : pair.tokenIn))
      .map((item) => item.tokenAddress || normalizeSymbol(item.symbol))
      .filter(Boolean)
  ).size;
}

function isTinyTransferNoise({
  selected,
  viablePairs,
  inbound,
  outbound,
}: {
  selected: TransferPair;
  viablePairs: TransferPair[];
  inbound: NormalizedTransfer[];
  outbound: NormalizedTransfer[];
}) {
  const selectedCopyToken = copyTokenKey(selected);
  const selectedCashToken = cashTokenKey(selected);
  const selectedCashValue = cashTransfer(selected).amountHuman;
  if (!selectedCopyToken || !selectedCashToken || selectedCashValue <= 0) return false;

  const viableAlternatesAreTinyDuplicateCash = viablePairs.filter((pair) => pair !== selected).every((pair) => {
    if (pair.side !== selected.side) return false;
    if (copyTokenKey(pair) !== selectedCopyToken) return false;
    if (cashTokenKey(pair) !== selectedCashToken) return false;
    return cashTransfer(pair).amountHuman <= selectedCashValue * 0.01;
  });
  if (!viableAlternatesAreTinyDuplicateCash) return false;

  const selectedTransfers = new Set([selected.tokenIn, selected.tokenOut]);
  return [...inbound, ...outbound]
    .filter((item) => !selectedTransfers.has(item))
    .every((item) => {
      const isCashSideNoise = selected.side === "sell" ? inbound.includes(item) : outbound.includes(item);
      return isCashSideNoise && item.amountHuman <= selectedCashValue * 0.01;
    });
}

function copyTokenKey(pair: TransferPair) {
  const token = pair.side === "buy" ? pair.tokenOut : pair.tokenIn;
  return token.tokenAddress || normalizeSymbol(token.symbol);
}

function cashTokenKey(pair: TransferPair) {
  return normalizeSymbol(cashTransfer(pair).symbol);
}

function cashTransfer(pair: TransferPair) {
  return pair.side === "buy" ? pair.tokenIn : pair.tokenOut;
}

function scorePair(tokenIn: NormalizedTransfer, tokenOut: NormalizedTransfer, side: TradeSide | "unknown") {
  if (side === "unknown") return 0;

  const copyToken = side === "buy" ? tokenOut : tokenIn;
  const cash = side === "buy" ? tokenIn : tokenOut;
  let score = 100;

  if (copyToken.tokenAddress) score += 20;
  if (!hasMissingTokenDetails(copyToken)) score += 10;
  if (isStableAsset(cash.symbol)) score += 8;
  if (isNativeAsset(cash.symbol)) score += 6;

  return score;
}

function inferSide(tokenInSymbol?: string, tokenOutSymbol?: string): TradeSide | "unknown" {
  const input = normalizeSymbol(tokenInSymbol);
  const output = normalizeSymbol(tokenOutSymbol);

  if (isCashLike(input) && output && !isCashLike(output)) return "buy";
  if (input && !isCashLike(input) && isCashLike(output)) return "sell";
  return "unknown";
}

function isCashLike(symbol: string) {
  return STABLE_OR_NATIVE_ASSETS.has(symbol);
}

function normalizeSymbol(symbol?: string) {
  return (symbol ?? "").trim().toUpperCase();
}

function isStableAsset(symbol?: string) {
  return ["USDC", "USDT", "DAI"].includes(normalizeSymbol(symbol));
}

function isNativeAsset(symbol?: string) {
  return ["ETH", "WETH"].includes(normalizeSymbol(symbol));
}

function hasMissingTokenDetails(item: NormalizedTransfer | null) {
  if (!item) return true;
  const isNative = !item.tokenAddress;
  if (isNative) return !item.symbol || item.amountHuman === 0;
  return !item.symbol || item.amountHuman === 0 || !item.tokenAddress;
}

function describeDecodedPair(side: TradeSide, tokenInSymbol: string, tokenOutSymbol: string) {
  if (side === "buy") {
    return `Paired wallet transfers indicate a likely buy using ${tokenInSymbol || "cash/native asset"} for ${tokenOutSymbol || "the received token"}.`;
  }
  return `Paired wallet transfers indicate a likely sell of ${tokenInSymbol || "the sent token"} into ${tokenOutSymbol || "cash/native asset"}.`;
}

function describeAmbiguousPair(side: TradeSide, tokenInSymbol: string, tokenOutSymbol: string) {
  if (side === "buy") {
    return `Multiple inbound or outbound transfers were found; selected the likely buy using ${tokenInSymbol || "cash/native asset"} for ${tokenOutSymbol || "the received token"}. Review before copying.`;
  }
  return `Multiple inbound or outbound transfers were found; selected the likely sell of ${tokenInSymbol || "the sent token"} into ${tokenOutSymbol || "cash/native asset"}. Review before copying.`;
}

function describeMultipleCopyTokens(side: TradeSide | "unknown", tokenInSymbol: string, tokenOutSymbol: string) {
  if (side === "buy") {
    return `Multiple possible received tokens were found; selected the likely buy using ${tokenInSymbol || "cash/native asset"} for ${tokenOutSymbol || "the received token"}. Review before copying.`;
  }
  return `Multiple possible sent tokens were found; selected the likely sell of ${tokenInSymbol || "the sent token"} into ${tokenOutSymbol || "cash/native asset"}. Review before copying.`;
}
