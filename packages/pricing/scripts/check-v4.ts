/**
 * Read-only live check for the Uniswap V4 pricing fix. Given a Base tx hash of a swap, it pulls the
 * receipt, extracts the V4 poolId (the PoolManager Swap event's indexed `id`) and the counter
 * currency, then runs the SAME pricing path the engine uses — proving a V4-only token (e.g. LOCAL)
 * is now priceable/measurable instead of skipping with `no-liquidity-data`.
 *
 * Never writes anything. Uses the project's Base RPC (ALCHEMY_API_KEY from .env).
 *
 *   pnpm check-v4 <baseTxHash> [tokenAddress]
 *
 * tokenAddress defaults to LOCAL (0xc92b…8ba3). It's whichever side of the swap you want priced;
 * the other side is treated as the counter currency.
 */
import { createPublicClient, http, parseAbiItem, decodeEventLog } from "viem";
import { base } from "viem/chains";
import { existsSync, readFileSync } from "fs";
import { resolve } from "path";
import { fileURLToPath } from "url";
import { getUsdPriceResult, getLiquidityUsdResult } from "../src/price.ts";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
loadLocalEnv(resolve(__dirname, "../../../.env"));

const V4_POOL_MANAGER = "0x498581ff718922c3f8e6a244956af099b2652b2b"; // Base, verified on-chain
const V4_SWAP = parseAbiItem(
  "event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)"
);
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const LOCAL = "0xc92b90f70b421e6349ad3513100b1933ed108ba3".toLowerCase();
const MIN_LIQUIDITY_USD = 1_000; // your current setting

async function main() {
  const txHash = process.argv[2];
  const token = (process.argv[3] ?? LOCAL).toLowerCase();
  if (!txHash) {
    console.error("usage: pnpm check-v4 <baseTxHash> [tokenAddress]");
    process.exit(1);
  }

  const apiKey = process.env["BASE_ALCHEMY_API_KEY"] ?? process.env["ALCHEMY_API_KEY"];
  if (!apiKey) { console.error("No ALCHEMY_API_KEY in .env"); process.exit(1); }
  const client = createPublicClient({ chain: base, transport: http(`https://base-mainnet.g.alchemy.com/v2/${apiKey}`) });

  const receipt = await client.getTransactionReceipt({ hash: txHash as `0x${string}` });

  // poolId = the PoolManager Swap event's indexed `id`.
  const swapLog = receipt.logs.find((l) => l.address.toLowerCase() === V4_POOL_MANAGER);
  if (!swapLog) { console.error("No Uniswap V4 PoolManager Swap log in this tx — is it a V4 swap on Base?"); process.exit(1); }
  const decoded = decodeEventLog({ abi: [V4_SWAP], data: swapLog.data, topics: swapLog.topics, strict: false });
  const poolId = ((decoded.args as { id?: string }).id ?? swapLog.topics[1]!).toLowerCase();

  // Counter currency = the non-target ERC20 moved by the swap (Transfer logs).
  const movedTokens = new Set(
    receipt.logs.filter((l) => l.topics[0]?.toLowerCase() === TRANSFER_TOPIC).map((l) => l.address.toLowerCase())
  );
  const counter = [...movedTokens].find((a) => a !== token);
  if (!counter) { console.error(`Could not find a counter currency (tokens moved: ${[...movedTokens].join(", ")})`); process.exit(1); }

  console.log(`tx          ${txHash}`);
  console.log(`token       ${token}`);
  console.log(`poolId      ${poolId}`);
  console.log(`counter     ${counter}`);
  console.log("─".repeat(60));

  const hint = { poolId, counterCurrency: counter };
  const price = await getUsdPriceResult("base", token, client, hint);
  const liq = await getLiquidityUsdResult("base", token, client, hint);

  console.log("priceUsd   ", price?.priceUsd ?? "(null)", price ? `[${price.venue ?? price.source}]` : "");
  console.log("liquidityUsd", liq?.liquidityUsd ?? "(null)", liq ? `[${liq.venue}/${liq.method}]` : "");
  console.log("─".repeat(60));
  if (liq === null) {
    console.log("RESULT: still no liquidity data — would skip `no-liquidity-data`. Check poolId/counter/RPC.");
  } else if (liq.liquidityUsd < MIN_LIQUIDITY_USD) {
    console.log(`RESULT: liquidity $${liq.liquidityUsd.toFixed(0)} < MIN_LIQUIDITY_USD $${MIN_LIQUIDITY_USD} → would skip \`below-min-liquidity\`.`);
  } else {
    console.log(`RESULT: ✅ liquidity $${liq.liquidityUsd.toFixed(0)} ≥ $${MIN_LIQUIDITY_USD} and priceable → the buy would be evaluated (no longer no-liquidity-data).`);
  }
}

function loadLocalEnv(path: string): void {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const sep = trimmed.indexOf("=");
    if (sep <= 0) continue;
    const key = trimmed.slice(0, sep).trim();
    if (process.env[key] !== undefined) continue;
    process.env[key] = trimmed.slice(sep + 1).trim().replace(/^['"]|['"]$/g, "");
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
