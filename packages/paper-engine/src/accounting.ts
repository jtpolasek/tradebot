export type AccountingPortfolio = {
  cashUsd: number;
  realizedPnlUsd: number;
  feesPaidUsd: number;
};

export type AccountingPosition = {
  quantity: number;
  averageEntryUsd: number;
  costBasisUsd: number;
  realizedPnlUsd: number;
  feesPaidUsd: number;
};

export type TradeInput = {
  side: "buy" | "sell";
  quantity: number;
  notionalUsd: number;
  gasUsd: number;
  slippageUsd: number;
  dexFeeUsd: number;
  totalCostUsd: number;
  sellProceedsUsd: number;
};

export function applyTradeToState(input: {
  portfolio: AccountingPortfolio;
  position: AccountingPosition | null;
  trade: TradeInput;
}): {
  portfolio: AccountingPortfolio;
  position: AccountingPosition;
  realizedPnlUsd: number;
} {
  const { portfolio, position, trade } = input;
  const fees = trade.gasUsd + trade.slippageUsd + trade.dexFeeUsd;

  if (trade.side === "buy") {
    if (portfolio.cashUsd < trade.totalCostUsd) {
      throw new Error("Insufficient paper cash for this buy after fees.");
    }
    const existingQuantity = position?.quantity ?? 0;
    const existingCost = position?.costBasisUsd ?? 0;
    const nextQuantity = existingQuantity + trade.quantity;
    const nextCost = existingCost + trade.notionalUsd + fees;

    return {
      portfolio: {
        cashUsd: portfolio.cashUsd - trade.totalCostUsd,
        realizedPnlUsd: portfolio.realizedPnlUsd,
        feesPaidUsd: portfolio.feesPaidUsd + fees,
      },
      position: {
        quantity: nextQuantity,
        averageEntryUsd: nextQuantity > 0 ? nextCost / nextQuantity : 0,
        costBasisUsd: nextCost,
        realizedPnlUsd: position?.realizedPnlUsd ?? 0,
        feesPaidUsd: (position?.feesPaidUsd ?? 0) + fees,
      },
      realizedPnlUsd: 0,
    };
  }

  if (!position || position.quantity < trade.quantity) {
    throw new Error("Insufficient token balance for this sell.");
  }

  const costPortion = position.averageEntryUsd * trade.quantity;
  const realizedPnlUsd = trade.sellProceedsUsd - costPortion;
  const nextQuantity = position.quantity - trade.quantity;
  const nextCostBasis = Math.max(0, position.costBasisUsd - costPortion);

  return {
    portfolio: {
      cashUsd: portfolio.cashUsd + trade.sellProceedsUsd,
      realizedPnlUsd: portfolio.realizedPnlUsd + realizedPnlUsd,
      feesPaidUsd: portfolio.feesPaidUsd + fees,
    },
    position: {
      quantity: nextQuantity,
      averageEntryUsd: nextQuantity > 0 ? nextCostBasis / nextQuantity : 0,
      costBasisUsd: nextQuantity > 0 ? nextCostBasis : 0,
      realizedPnlUsd: position.realizedPnlUsd + realizedPnlUsd,
      feesPaidUsd: position.feesPaidUsd + fees,
    },
    realizedPnlUsd,
  };
}

export function applyTotalLossToState(input: {
  portfolio: AccountingPortfolio;
  position: AccountingPosition;
}): {
  portfolio: AccountingPortfolio;
  position: AccountingPosition;
  realizedPnlUsd: number;
} {
  const { portfolio, position } = input;
  const realizedPnlUsd = -position.costBasisUsd;

  return {
    portfolio: {
      cashUsd: portfolio.cashUsd,
      realizedPnlUsd: portfolio.realizedPnlUsd + realizedPnlUsd,
      feesPaidUsd: portfolio.feesPaidUsd,
    },
    position: {
      quantity: 0,
      averageEntryUsd: 0,
      costBasisUsd: 0,
      realizedPnlUsd: position.realizedPnlUsd + realizedPnlUsd,
      feesPaidUsd: position.feesPaidUsd,
    },
    realizedPnlUsd,
  };
}
