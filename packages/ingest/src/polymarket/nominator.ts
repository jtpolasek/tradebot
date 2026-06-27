/**
 * A Nominator is a pluggable discovery source that *proposes* candidate wallets (Prospects) with the
 * minimal metadata needed for the cheap Stage-1 cut. It never judges quality — evaluation/promotion is
 * a separate stage (ADR 0005 §1). Keeping this an interface lets crawl/scan nominators be added later
 * without touching the evaluation or promotion code.
 */
export interface Nomination {
  /** lowercase proxyWallet address */
  address: string;
  /** the discovery source that proposed it, e.g. "leaderboard" */
  source: string;
  userName?: string | undefined;
  xUsername?: string | undefined;
  pnlUsd: number;
  volUsd: number;
  /** true if the address was corroborated by a second board (e.g. appeared in ALL/PNL too) */
  corroborated?: boolean | undefined;
}

export interface Nominator {
  nominate(): Promise<Nomination[]>;
}
