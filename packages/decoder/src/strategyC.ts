import { decodeFunctionData } from "viem";
import type { RawTxEvent, TradeSignal, EvmChainId } from "@tradebot/core";
import type { TokenMetadataResolver } from "./tokenMetadata.js";

// Uniswap V2 router ABI fragments
const V2_ABI = [
  {
    name: "swapExactTokensForTokens",
    type: "function",
    inputs: [
      { name: "amountIn", type: "uint256" },
      { name: "amountOutMin", type: "uint256" },
      { name: "path", type: "address[]" },
      { name: "to", type: "address" },
      { name: "deadline", type: "uint256" },
    ],
  },
  {
    name: "swapExactETHForTokens",
    type: "function",
    inputs: [
      { name: "amountOutMin", type: "uint256" },
      { name: "path", type: "address[]" },
      { name: "to", type: "address" },
      { name: "deadline", type: "uint256" },
    ],
  },
  {
    name: "swapExactTokensForETH",
    type: "function",
    inputs: [
      { name: "amountIn", type: "uint256" },
      { name: "amountOutMin", type: "uint256" },
      { name: "path", type: "address[]" },
      { name: "to", type: "address" },
      { name: "deadline", type: "uint256" },
    ],
  },
] as const;

// UniversalRouter execute selector
const UNIVERSAL_ROUTER_EXECUTE_SELECTOR = "0x3593564c";

export async function strategyC(
  event: RawTxEvent,
  walletAddress: string,
  meta: TokenMetadataResolver
): Promise<Pick<TradeSignal, "tokenIn" | "tokenOut" | "amountIn" | "amountOut" | "venue"> | null> {
  if (event.source !== "mempool" || !event.input) return null;

  const calldata = event.input;

  // Try UniversalRouter first
  if (calldata.startsWith(UNIVERSAL_ROUTER_EXECUTE_SELECTOR)) {
    return decodeUniversalRouter(calldata, event.chain, meta);
  }

  // Try V2 router families
  return decodeV2Router(calldata, event.chain, event.valueWei, meta);
}

async function decodeUniversalRouter(
  calldata: `0x${string}`,
  chain: EvmChainId,
  meta: TokenMetadataResolver
): Promise<Pick<TradeSignal, "tokenIn" | "tokenOut" | "amountIn" | "amountOut" | "venue"> | null> {
  try {
    // UniversalRouter execute(bytes commands, bytes[] inputs, uint256 deadline)
    const abi = [
      {
        name: "execute",
        type: "function",
        inputs: [
          { name: "commands", type: "bytes" },
          { name: "inputs", type: "bytes[]" },
          { name: "deadline", type: "uint256" },
        ],
      },
    ] as const;

    const decoded = decodeFunctionData({ abi, data: calldata });
    const { commands, inputs } = (decoded.args as unknown) as { commands: `0x${string}`; inputs: readonly `0x${string}`[] };

    // Parse commands byte-by-byte to find V3_SWAP_EXACT_IN (0x00) or V2_SWAP_EXACT_IN (0x08)
    const commandBytes = hexToBytes(commands);
    for (let i = 0; i < commandBytes.length; i++) {
      const cmd = commandBytes[i];
      const input = inputs[i];
      if (cmd === undefined || !input) continue;

      // V3_SWAP_EXACT_IN = 0x00
      if (cmd === 0x00) {
        const result = decodeV3SwapInput(input, chain, meta);
        if (result) return result;
      }
      // V2_SWAP_EXACT_IN = 0x08
      if (cmd === 0x08) {
        const result = decodeV2SwapInput(input, chain, meta);
        if (result) return result;
      }
    }
  } catch {
    // Unrecognized — fall through
  }
  return null;
}

async function decodeV3SwapInput(
  input: `0x${string}`,
  chain: EvmChainId,
  meta: TokenMetadataResolver
): Promise<Pick<TradeSignal, "tokenIn" | "tokenOut" | "amountIn" | "amountOut" | "venue"> | null> {
  try {
    // V3_SWAP_EXACT_IN: (address recipient, uint256 amountIn, uint256 amountOutMin, bytes path, bool payerIsUser)
    const { decodeAbiParameters } = await import("viem");
    const [, amountIn, amountOutMin, path] = decodeAbiParameters(
      [
        { name: "recipient", type: "address" },
        { name: "amountIn", type: "uint256" },
        { name: "amountOutMin", type: "uint256" },
        { name: "path", type: "bytes" },
        { name: "payerIsUser", type: "bool" },
      ],
      input
    );

    // Path encoding: tokenIn (20 bytes) + fee (3 bytes) + tokenOut (20 bytes) [+ more hops]
    const pathHex = (path as `0x${string}`).slice(2);
    if (pathHex.length < 86) return null; // need at least tokenIn + fee + tokenOut

    const tokenInAddr = `0x${pathHex.slice(0, 40)}`.toLowerCase();
    const tokenOutAddr = `0x${pathHex.slice(46, 86)}`.toLowerCase();

    const [metaIn, metaOut] = await Promise.all([meta.resolve(chain, tokenInAddr), meta.resolve(chain, tokenOutAddr)]);

    return {
      tokenIn: { chain, address: tokenInAddr, symbol: metaIn.symbol, decimals: metaIn.decimals },
      tokenOut: { chain, address: tokenOutAddr, symbol: metaOut.symbol, decimals: metaOut.decimals },
      amountIn: amountIn as bigint,
      amountOut: amountOutMin as bigint, // conservative estimate
      venue: "uniswap-v3",
    };
  } catch {
    return null;
  }
}

async function decodeV2SwapInput(
  input: `0x${string}`,
  chain: EvmChainId,
  meta: TokenMetadataResolver
): Promise<Pick<TradeSignal, "tokenIn" | "tokenOut" | "amountIn" | "amountOut" | "venue"> | null> {
  try {
    const { decodeAbiParameters } = await import("viem");
    // V2_SWAP_EXACT_IN: (address recipient, uint256 amountIn, uint256 amountOutMin, address[] path, bool payerIsUser)
    const [, amountIn, amountOutMin, path] = decodeAbiParameters(
      [
        { name: "recipient", type: "address" },
        { name: "amountIn", type: "uint256" },
        { name: "amountOutMin", type: "uint256" },
        { name: "path", type: "address[]" },
        { name: "payerIsUser", type: "bool" },
      ],
      input
    );

    const pathArr = path as string[];
    const tokenInAddr = pathArr[0]?.toLowerCase();
    const tokenOutAddr = pathArr[pathArr.length - 1]?.toLowerCase();
    if (!tokenInAddr || !tokenOutAddr) return null;

    const [metaIn, metaOut] = await Promise.all([meta.resolve(chain, tokenInAddr), meta.resolve(chain, tokenOutAddr)]);

    return {
      tokenIn: { chain, address: tokenInAddr, symbol: metaIn.symbol, decimals: metaIn.decimals },
      tokenOut: { chain, address: tokenOutAddr, symbol: metaOut.symbol, decimals: metaOut.decimals },
      amountIn: amountIn as bigint,
      amountOut: amountOutMin as bigint,
      venue: "uniswap-v2",
    };
  } catch {
    return null;
  }
}

async function decodeV2Router(
  calldata: `0x${string}`,
  chain: EvmChainId,
  valueWei: bigint | undefined,
  meta: TokenMetadataResolver
): Promise<Pick<TradeSignal, "tokenIn" | "tokenOut" | "amountIn" | "amountOut" | "venue"> | null> {
  try {
    const decoded = decodeFunctionData({ abi: V2_ABI, data: calldata });

    if (decoded.functionName === "swapExactTokensForTokens") {
      const { amountIn, amountOutMin, path } = (decoded.args as unknown) as {
        amountIn: bigint;
        amountOutMin: bigint;
        path: readonly string[];
      };
      const tokenInAddr = path[0]?.toLowerCase();
      const tokenOutAddr = path[path.length - 1]?.toLowerCase();
      if (!tokenInAddr || !tokenOutAddr) return null;
      const [metaIn, metaOut] = await Promise.all([meta.resolve(chain, tokenInAddr), meta.resolve(chain, tokenOutAddr)]);
      return {
        tokenIn: { chain, address: tokenInAddr, symbol: metaIn.symbol, decimals: metaIn.decimals },
        tokenOut: { chain, address: tokenOutAddr, symbol: metaOut.symbol, decimals: metaOut.decimals },
        amountIn,
        amountOut: amountOutMin,
        venue: "uniswap-v2",
      };
    }

    if (decoded.functionName === "swapExactETHForTokens") {
      const { amountOutMin, path } = (decoded.args as unknown) as {
        amountOutMin: bigint;
        path: readonly string[];
      };
      const tokenOutAddr = path[path.length - 1]?.toLowerCase();
      if (!tokenOutAddr) return null;
      const metaOut = await meta.resolve(chain, tokenOutAddr);
      const wethMeta = await meta.resolve(chain, "");
      return {
        tokenIn: { chain, address: "", symbol: wethMeta.symbol, decimals: wethMeta.decimals },
        tokenOut: { chain, address: tokenOutAddr, symbol: metaOut.symbol, decimals: metaOut.decimals },
        amountIn: valueWei ?? 0n,
        amountOut: amountOutMin,
        venue: "uniswap-v2",
      };
    }

    if (decoded.functionName === "swapExactTokensForETH") {
      const { amountIn, amountOutMin, path } = (decoded.args as unknown) as {
        amountIn: bigint;
        amountOutMin: bigint;
        path: readonly string[];
      };
      const tokenInAddr = path[0]?.toLowerCase();
      if (!tokenInAddr) return null;
      const metaIn = await meta.resolve(chain, tokenInAddr);
      const wethMeta = await meta.resolve(chain, "");
      return {
        tokenIn: { chain, address: tokenInAddr, symbol: metaIn.symbol, decimals: metaIn.decimals },
        tokenOut: { chain, address: "", symbol: wethMeta.symbol, decimals: wethMeta.decimals },
        amountIn,
        amountOut: amountOutMin,
        venue: "uniswap-v2",
      };
    }
  } catch {
    // Unrecognized calldata — confirmed path will handle it
  }
  return null;
}

function hexToBytes(hex: `0x${string}`): Uint8Array {
  const str = hex.slice(2);
  const bytes = new Uint8Array(str.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(str.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}
