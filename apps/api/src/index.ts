import { createPublicClient, webSocket } from "viem";
import { mainnet, base as baseChain } from "viem/chains";
import { BrainWeightProvider } from "@tradebot/brain";
import { config, installCrashHandlers } from "@tradebot/core";
import { getDb } from "@tradebot/store";
import { createApiApp } from "./app.js";
import { apiConfig } from "./config.js";

const healthThresholds = {
  heartbeatStaleSec: config.HEARTBEAT_STALE_SEC,
  chainStaleSecByChain: {
    eth: config.CHAIN_STALE_SEC_ETH,
    base: config.CHAIN_STALE_SEC_BASE,
    polygon: config.CHAIN_STALE_SEC_POLYGON,
  },
  rssSoftLimitBytes: config.RSS_SOFT_LIMIT_MB * 1024 * 1024,
  prospectStaleSec: (config.PROSPECT_DISCOVERY_INTERVAL_MS * 2) / 1000,
};

const rpcClients = {
  eth: createPublicClient({
    chain: mainnet,
    batch: { multicall: true },
    transport: webSocket(`wss://eth-mainnet.g.alchemy.com/v2/${config.ALCHEMY_API_KEY}`),
  }),
  base: createPublicClient({
    chain: baseChain,
    batch: { multicall: true },
    transport: webSocket(`wss://base-mainnet.g.alchemy.com/v2/${config.BASE_ALCHEMY_API_KEY ?? config.ALCHEMY_API_KEY}`),
  }),
};

const app = await createApiApp({
  db: getDb(),
  apiConfig,
  healthThresholds,
  rpcClients,
  manualWeightProvider: new BrainWeightProvider(),
});

installCrashHandlers(app.log);

try {
  await app.listen({ port: apiConfig.API_PORT, host: "0.0.0.0" });
  console.log(`API listening on port ${apiConfig.API_PORT}`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
