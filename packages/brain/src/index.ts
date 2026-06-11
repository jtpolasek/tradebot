export { fifoRoundTrips, computeScoringResult } from "./scoring.js";
export type { TradeRow, RoundTrip, ScoringResult, ScoreWindow } from "./scoring.js";

export { sigmoid, computeZScore, computeScore, scoreToWeight, shouldAutoMute } from "./weights.js";

export {
  classifyLiquidityTier,
  computePerLeaderMutes,
  runLiquidityNotch,
} from "./adaptation.js";
export type { FillRecord, AdaptationDeps, LiquidityTier } from "./adaptation.js";

export { BrainWeightProvider, startScorerJob, runScorerJob } from "./scorer.js";
