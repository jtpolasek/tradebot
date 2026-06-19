import { hexToString } from "viem";
import { NATIVE_TOKEN_PLACEHOLDER } from "@tradebot/core";
import type { EvmChainId } from "@tradebot/core";
import type { Db } from "@tradebot/store";
import { getToken, upsertToken } from "@tradebot/store";
import { createLogger } from "@tradebot/core";

// Loose structural interface — avoids viem type-identity issues across pnpm packages
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type MulticallClient = { multicall: (args: any) => Promise<any[]> };

const logger = createLogger("decoder:tokenMetadata");

export type TokenMeta = { symbol: string; name: string; decimals: number };

const ERC20_ABI = [
  { type: "function", name: "symbol", inputs: [], outputs: [{ type: "string" }], stateMutability: "view" },
  { type: "function", name: "name", inputs: [], outputs: [{ type: "string" }], stateMutability: "view" },
  { type: "function", name: "decimals", inputs: [], outputs: [{ type: "uint8" }], stateMutability: "view" },
  // bytes32 symbol variant (older tokens)
  { type: "function", name: "symbol", inputs: [], outputs: [{ type: "bytes32" }], stateMutability: "view" },
] as const;

const ETH_META: TokenMeta = { symbol: "ETH", name: "Ether", decimals: 18 };

export class TokenMetadataResolver {
  private readonly cache = new Map<string, TokenMeta>();

  constructor(
    private readonly db: Db,
    private readonly clients: Record<EvmChainId, MulticallClient>
  ) {}

  async resolve(chain: EvmChainId, address: string): Promise<TokenMeta> {
    const normalized = address.toLowerCase();

    if (!normalized || normalized === NATIVE_TOKEN_PLACEHOLDER) return ETH_META;

    const cacheKey = `${chain}:${normalized}`;
    const cached = this.cache.get(cacheKey);
    if (cached) return cached;

    const dbRow = await getToken(this.db, chain, normalized).catch(() => null);
    if (dbRow) {
      const meta: TokenMeta = { symbol: dbRow.symbol, name: dbRow.name, decimals: dbRow.decimals };
      this.cache.set(cacheKey, meta);
      return meta;
    }

    const meta = await this.fetchOnChain(chain, normalized);
    this.cache.set(cacheKey, meta);
    await upsertToken(this.db, { chain, address: normalized, symbol: meta.symbol, name: meta.name, decimals: meta.decimals, isBlocked: false }).catch((err: unknown) => {
      logger.warn({ err, chain, address: normalized }, "Failed to persist token metadata");
    });
    return meta;
  }

  private async fetchOnChain(chain: EvmChainId, address: string): Promise<TokenMeta> {
    const client = this.clients[chain];
    const addr = address as `0x${string}`;

    let symbol = "UNKNOWN";
    let name = "Unknown";
    let decimals = 18;

    try {
      const results = await client.multicall({
        contracts: [
          { address: addr, abi: ERC20_ABI, functionName: "symbol" },
          { address: addr, abi: ERC20_ABI, functionName: "name" },
          { address: addr, abi: ERC20_ABI, functionName: "decimals" },
        ],
        allowFailure: true,
      });
      const symbolResult = results[0];
      const nameResult = results[1];
      const decimalsResult = results[2];

      if (symbolResult?.status === "success") {
        const raw = symbolResult.result as string;
        // Handle bytes32 — if it looks like hex-encoded bytes32
        if (raw.startsWith("0x") && raw.length === 66) {
          symbol = hexToString(raw as `0x${string}`).replace(/\0/g, "").trim();
        } else {
          symbol = String(raw).trim() || "UNKNOWN";
        }
      }
      if (nameResult?.status === "success") {
        name = String(nameResult.result).trim() || "Unknown";
      }
      if (decimalsResult?.status === "success") {
        decimals = Number(decimalsResult.result);
      } else {
        logger.warn({ chain, address }, "decimals() call failed — defaulting to 18");
      }
    } catch (err) {
      logger.warn({ err, chain, address }, "On-chain token metadata fetch failed — using defaults");
    }

    return { symbol, name, decimals };
  }
}
