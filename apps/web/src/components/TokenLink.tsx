"use client";

import { ExternalLink } from "lucide-react";
import { explorerContractUrl, isNativePlaceholder, shortAddr, tokenTitle, type DisplayToken } from "@/lib/api";

type TokenLinkProps = {
  chain: string;
  token: DisplayToken;
};

export function TokenLink({ chain, token }: TokenLinkProps) {
  const href = explorerContractUrl(token.chain ?? chain, token.address);
  const label = tokenTitle(token);
  const isNative = isNativePlaceholder(token.address);
  const body = (
    <>
      <span className="token-name">{label}</span>
      {!isNative && <span className="mono subtle token-address">{shortAddr(token.address)}</span>}
      {href && <ExternalLink size={12} aria-hidden="true" />}
    </>
  );

  if (!href) {
    return <span className="token-link">{body}</span>;
  }

  return (
    <a className="token-link" href={href} target="_blank" rel="noreferrer" title={`Open ${label} contract`}>
      {body}
    </a>
  );
}
