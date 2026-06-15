"use client";

import { ExternalLink } from "lucide-react";
import { explorerTxUrl, shortHash } from "@/lib/api";

type TxLinkProps = {
  chain: string;
  txHash: string;
};

/** Transaction hash linked to the chain explorer. */
export function TxLink({ chain, txHash }: TxLinkProps) {
  const href = explorerTxUrl(chain, txHash);
  if (!href) return <span className="mono">{shortHash(txHash)}</span>;
  return (
    <a className="tx-link mono" href={href} target="_blank" rel="noreferrer" title="Open transaction on explorer">
      {shortHash(txHash)} <ExternalLink size={11} aria-hidden="true" />
    </a>
  );
}
