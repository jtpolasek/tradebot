import { fromBaseUnits } from "@tradebot/core";
import type { UnpricedFee } from "./zerox.js";

export type FeePriceAnchor = {
  address: string;
  usdPrice: number;
  decimals: number;
};

export type ValuedFees = {
  valuedUsd: number;
  pricedTokens: string[];
  stillUnpriced: UnpricedFee[];
};

export function valueUnpricedFees(unpriced: UnpricedFee[], anchors: FeePriceAnchor[]): ValuedFees {
  let valuedUsd = 0;
  const pricedTokens: string[] = [];
  const stillUnpriced: UnpricedFee[] = [];

  for (const fee of unpriced) {
    const anchor = anchors.find((a) => a.address.toLowerCase() === fee.token.toLowerCase());
    if (!anchor || !Number.isFinite(anchor.usdPrice) || anchor.usdPrice <= 0) {
      stillUnpriced.push(fee);
      continue;
    }
    try {
      valuedUsd += fromBaseUnits(fee.amount, anchor.decimals) * anchor.usdPrice;
      pricedTokens.push(fee.token.toLowerCase());
    } catch {
      stillUnpriced.push(fee);
    }
  }

  return { valuedUsd, pricedTokens, stillUnpriced };
}
