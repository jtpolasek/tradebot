"use client";

import { ExternalLink } from "lucide-react";
import { explorerAddressUrl, gmgnWalletUrl, polymarketProfileUrl, shortAddr } from "@/lib/api";

type WalletLinkProps = {
  chain: string;
  address: string;
  label?: string;
};

/** Wallet address with links out to the chain explorer and GMGN.ai. */
export function WalletLink({ chain, address, label }: WalletLinkProps) {
  const explorer = explorerAddressUrl(chain, address);
  const gmgn = gmgnWalletUrl(chain, address);
  const polymarket = polymarketProfileUrl(chain, address);

  return (
    <span className="wallet-link">
      {label && <span className="wallet-label">{label}</span>}
      {explorer ? (
        <a className="mono subtle wallet-address" href={explorer} target="_blank" rel="noreferrer" title="Open on explorer">
          {shortAddr(address)} <ExternalLink size={11} aria-hidden="true" />
        </a>
      ) : (
        <span className="mono subtle wallet-address">{shortAddr(address)}</span>
      )}
      {gmgn && (
        <a className="wallet-gmgn" href={gmgn} target="_blank" rel="noreferrer" title="Open on GMGN.ai">
          GMGN
        </a>
      )}
      {polymarket && (
        <a className="wallet-gmgn" href={polymarket} target="_blank" rel="noreferrer" title="Open Polymarket profile">
          Polymarket
        </a>
      )}
    </span>
  );
}
