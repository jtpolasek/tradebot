import { fromBaseUnits, CHAIN_IDS, QUOTE_ASSETS } from "@tradebot/core";
import type { ChainId } from "@tradebot/core";

export const ZEROX_PRICE_ENDPOINT = "/swap/allowance-holder/price";

export type ZeroxRawQuote = {
  buyAmount?: string;
  sellAmount?: string;
  gas?: string;
  gasPrice?: string;
  fees?: {
    integratorFee?: ZeroxFee | null;
    zeroExFee?: ZeroxFee | null;
    gasFee?: ZeroxFee | null;
  };
  issues?: unknown;
  liquidityAvailable?: boolean;
  [key: string]: unknown;
};

type ZeroxFee = {
  amount?: string;
  token?: string;
  type?: string;
};

export type UnpricedFee = {
  type: string;
  token: string;
  amount: string;
};

type ZeroxIssueMap = {
  liquidityAvailable?: boolean;
  simulationIncomplete?: boolean;
  invalidSourcesPassed?: string[];
  allowance?: unknown;
  balance?: unknown;
  [key: string]: unknown;
};

export type ZeroxPriceParams = {
  chainId?: number;
  sellToken: string;
  buyToken: string;
  sellAmount: string;
};

export type NormalizedZeroxQuote = {
  provider: "0x";
  endpoint: typeof ZEROX_PRICE_ENDPOINT;
  chainId: number;
  sellToken: string;
  buyToken: string;
  sellAmount: string;
  buyAmount: string;
  gasUnits: number;
  gasPriceWei: number;
  dexFeeUsd: number;
  unpricedFees: UnpricedFee[];
  warnings: string[];
  rawResponse: ZeroxRawQuote;
};

export async function getZeroxPrice(params: ZeroxPriceParams) {
  const apiKey = process.env["ZEROX_API_KEY"];
  if (!apiKey) {
    throw new Error("ZEROX_API_KEY is required to request swap prices.");
  }

  const search = new URLSearchParams({
    chainId: String(params.chainId ?? CHAIN_IDS.eth),
    sellToken: params.sellToken,
    buyToken: params.buyToken,
    sellAmount: params.sellAmount,
  });

  const response = await fetch(`https://api.0x.org${ZEROX_PRICE_ENDPOINT}?${search.toString()}`, {
    headers: {
      "0x-api-key": apiKey,
      "0x-version": "v2",
    },
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(formatZeroxHttpError(response.status, detail));
  }

  return normalizeZeroxPriceQuote(params, (await response.json()) as ZeroxRawQuote);
}

export function normalizeZeroxPriceQuote(
  params: ZeroxPriceParams,
  rawResponse: ZeroxRawQuote
): NormalizedZeroxQuote {
  const warnings = summarizeZeroxIssues(rawResponse);
  const gasUnits = finiteNumber(rawResponse.gas);
  const gasPriceWei = finiteNumber(rawResponse.gasPrice);

  if (!gasUnits || !gasPriceWei) {
    warnings.push("0x did not return a complete gas estimate; gas may be understated.");
  }

  const chainId = params.chainId ?? CHAIN_IDS.eth;
  const { dexFeeUsd, unpriced } = summarizeDexFees(rawResponse, chainId);

  return {
    provider: "0x",
    endpoint: ZEROX_PRICE_ENDPOINT,
    chainId,
    sellToken: params.sellToken,
    buyToken: params.buyToken,
    sellAmount: rawResponse.sellAmount ?? params.sellAmount,
    buyAmount: rawResponse.buyAmount ?? "0",
    gasUnits,
    gasPriceWei,
    dexFeeUsd,
    unpricedFees: unpriced,
    warnings,
    rawResponse,
  };
}

export function summarizeZeroxIssues(quote: Pick<ZeroxRawQuote, "issues" | "liquidityAvailable">) {
  const warnings: string[] = [];
  const issues = asIssueMap(quote.issues);

  if (quote.liquidityAvailable === false || issues?.liquidityAvailable === false) {
    warnings.push("No usable 0x liquidity or route was found for this token and trade size.");
  }
  if (issues?.simulationIncomplete) {
    warnings.push("0x could not fully simulate this swap, so execution may revert or pricing may be unreliable.");
  }
  if (Array.isArray(issues?.invalidSourcesPassed) && issues.invalidSourcesPassed.length) {
    warnings.push(`0x ignored invalid liquidity sources: ${issues.invalidSourcesPassed.join(", ")}.`);
  }
  if (issues && !warnings.length && hasVisibleUnknownIssue(issues)) {
    warnings.push("0x returned quote issues that are not yet classified. Treat this simulation as unreliable.");
  }

  return warnings;
}

export function assertUsableZeroxQuote(quote: NormalizedZeroxQuote, side: "buy" | "sell") {
  const amount = Number(quote.buyAmount);
  const hasNoLiquidity = quote.warnings.some((w) => w.startsWith("No usable 0x liquidity"));

  if (hasNoLiquidity || !Number.isFinite(amount) || amount <= 0) {
    const reason = quote.warnings.length ? ` ${quote.warnings.join(" ")}` : "";
    throw new Error(
      `No usable 0x liquidity/route for this ${side}. The simulator cannot price this trade, which usually means the position is not practically tradable at this size.${reason}`
    );
  }
}

export function summarizeDexFees(
  quote: ZeroxRawQuote,
  chainId: number = CHAIN_IDS.eth
): { dexFeeUsd: number; unpriced: UnpricedFee[] } {
  const fees = quote.fees;
  if (!fees) return { dexFeeUsd: 0, unpriced: [] };

  const chain: ChainId = chainId === CHAIN_IDS.base ? "base" : "eth";
  // USDC is always the first quote asset on both chains
  const usdcAddress = QUOTE_ASSETS[chain][0]!;
  const isUsdc = (token?: string) => token?.toLowerCase() === usdcAddress.toLowerCase();
  const usdcDecimals = 6;

  let dexFeeUsd = 0;
  for (const fee of [fees.integratorFee, fees.zeroExFee, fees.gasFee]) {
    if (!fee?.amount || !isUsdc(fee.token)) continue;
    try {
      dexFeeUsd += fromBaseUnits(fee.amount, usdcDecimals);
    } catch {
      // unparseable USDC fee contributes nothing
    }
  }

  const unpriced: UnpricedFee[] = [];
  for (const [type, fee] of [
    ["zeroExFee", fees.zeroExFee],
    ["integratorFee", fees.integratorFee],
  ] as const) {
    if (!fee?.amount || !fee.token || isUsdc(fee.token)) continue;
    const amount = Number(fee.amount);
    if (!Number.isFinite(amount) || amount <= 0) continue;
    unpriced.push({ type, token: fee.token, amount: fee.amount });
  }

  return { dexFeeUsd, unpriced };
}

function formatZeroxHttpError(status: number, detail: string) {
  const parsed = parseJson(detail);
  const text = JSON.stringify(parsed ?? detail).toLowerCase();
  if (
    text.includes("liquidity") ||
    text.includes("no route") ||
    text.includes("no_route") ||
    text.includes("insufficient_asset_liquidity")
  ) {
    return `No usable 0x liquidity/route for this trade. 0x rejected the quote request with ${status}.`;
  }
  return `0x price request failed with ${status}: ${detail.slice(0, 180)}`;
}

function parseJson(value: string) {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function asIssueMap(issues: unknown): ZeroxIssueMap | null {
  if (!issues || typeof issues !== "object") return null;
  return issues as ZeroxIssueMap;
}

function hasVisibleUnknownIssue(issues: ZeroxIssueMap) {
  const ignoredPaperModeKeys = new Set(["allowance", "balance"]);
  return Object.keys(issues).some((key) => !ignoredPaperModeKeys.has(key));
}

function finiteNumber(value: unknown) {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? number : 0;
}
