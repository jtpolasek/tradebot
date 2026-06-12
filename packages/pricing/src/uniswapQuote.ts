import { CHAIN_IDS } from "@tradebot/core";

export const UNISWAP_QUOTE_ENDPOINT = "/quote";
const UNISWAP_API_URL = "https://trade-api.gateway.uniswap.org/v1";
const DEFAULT_SWAPPER_ADDRESS = "0x0000000000000000000000000000000000000001";

export type UniswapRawQuote = {
  requestId?: string;
  routing?: string;
  quote?: {
    chainId?: number;
    input?: { amount?: string; token?: string; maximumAmount?: string };
    output?: { amount?: string; token?: string; minimumAmount?: string; recipient?: string };
    classicGasUseEstimateUSD?: string;
    portionAmount?: string;
    portionBips?: number;
    quoteId?: string;
    slippageTolerance?: number;
    aggregatedOutputs?: Array<{ token?: string; amount?: string; minAmount?: string }>;
  };
  txFailureReason?: string;
  detail?: string;
  error?: string;
  [key: string]: unknown;
};

export type UniswapQuoteParams = {
  chainId?: number;
  sellToken: string;
  buyToken: string;
  sellAmount: string;
  slippageBps: number;
  swapper?: string;
};

export type NormalizedUniswapQuote = {
  provider: "Uniswap";
  endpoint: typeof UNISWAP_QUOTE_ENDPOINT;
  chainId: number;
  sellToken: string;
  buyToken: string;
  sellAmount: string;
  buyAmount: string;
  gasUsd: number;
  dexFeeUsd: number;
  warnings: string[];
  rawResponse: UniswapRawQuote;
};

export async function getUniswapQuote(params: UniswapQuoteParams) {
  const apiKey = process.env["UNISWAP_API_KEY"];
  if (!apiKey) {
    throw new Error("UNISWAP_API_KEY is required to request Uniswap quotes.");
  }

  const chainId = params.chainId ?? CHAIN_IDS.eth;
  const response = await fetch(`${UNISWAP_API_URL}${UNISWAP_QUOTE_ENDPOINT}`, {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "accept": "application/json",
      "content-type": "application/json",
      "x-permit2-disabled": "true",
    },
    body: JSON.stringify({
      type: "EXACT_INPUT",
      amount: params.sellAmount,
      tokenInChainId: chainId,
      tokenOutChainId: chainId,
      tokenIn: params.sellToken,
      tokenOut: params.buyToken,
      swapper: params.swapper ?? process.env["UNISWAP_SWAPPER_ADDRESS"] ?? DEFAULT_SWAPPER_ADDRESS,
      slippageTolerance: params.slippageBps / 100,
      routingPreference: "FASTEST",
      protocols: ["V2", "V3", "V4"],
    }),
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(formatUniswapHttpError(response.status, detail));
  }

  return normalizeUniswapQuote(params, (await response.json()) as UniswapRawQuote);
}

export function normalizeUniswapQuote(
  params: UniswapQuoteParams,
  rawResponse: UniswapRawQuote
): NormalizedUniswapQuote {
  const quote = rawResponse.quote ?? {};
  const warnings = summarizeUniswapIssues(rawResponse);

  return {
    provider: "Uniswap",
    endpoint: UNISWAP_QUOTE_ENDPOINT,
    chainId: quote.chainId ?? params.chainId ?? CHAIN_IDS.eth,
    sellToken: quote.input?.token ?? params.sellToken,
    buyToken: quote.output?.token ?? params.buyToken,
    sellAmount: quote.input?.amount ?? params.sellAmount,
    buyAmount: quote.output?.amount ?? quote.aggregatedOutputs?.[0]?.amount ?? "0",
    gasUsd: finiteNumber(quote.classicGasUseEstimateUSD),
    dexFeeUsd: 0,
    warnings,
    rawResponse,
  };
}

export function assertUsableUniswapQuote(quote: NormalizedUniswapQuote) {
  const hasNoRoute = quote.warnings.some((w) => w.startsWith("No usable Uniswap route"));
  if (hasNoRoute || !isPositiveIntegerString(quote.buyAmount)) {
    const reason = quote.warnings.length ? ` ${quote.warnings.join(" ")}` : "";
    throw new Error(`No usable Uniswap route for this trade.${reason}`);
  }
}

export function summarizeUniswapIssues(
  rawResponse: Pick<UniswapRawQuote, "txFailureReason" | "detail" | "error">
) {
  const warnings: string[] = [];
  const text = [rawResponse.txFailureReason, rawResponse.detail, rawResponse.error]
    .filter(Boolean)
    .join(" ");
  if (!text) return warnings;

  const lower = text.toLowerCase();
  if (lower.includes("no quote") || lower.includes("no route") || lower.includes("no quotes available")) {
    warnings.push("No usable Uniswap route was found for this token and trade size.");
  } else {
    warnings.push(`Uniswap returned a quote warning: ${text.slice(0, 180)}`);
  }
  return warnings;
}

function formatUniswapHttpError(status: number, detail: string) {
  const parsed = parseJson(detail);
  const text = JSON.stringify(parsed ?? detail).toLowerCase();
  if (text.includes("no quote") || text.includes("no route") || text.includes("no quotes available")) {
    return `No usable Uniswap route for this trade. Uniswap rejected the quote request with ${status}.`;
  }
  return `Uniswap quote request failed with ${status}: ${detail.slice(0, 180)}`;
}

function parseJson(value: string) {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function finiteNumber(value: unknown) {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? number : 0;
}

function isPositiveIntegerString(value: string) {
  try {
    return BigInt(value) > 0n;
  } catch {
    return false;
  }
}
