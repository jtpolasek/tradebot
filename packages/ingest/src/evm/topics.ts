import { pad, keccak256, toHex } from "viem";

export const TRANSFER_TOPIC = keccak256(
  toHex("Transfer(address,address,uint256)")
) as `0x${string}`;

/**
 * Pads an EVM address to 32 bytes (topic format).
 * Input must be a lowercase 0x-prefixed 20-byte hex address.
 */
export function padAddressToTopic(address: string): `0x${string}` {
  return pad(address as `0x${string}`, { size: 32 });
}

/**
 * Builds topic filter arrays for Transfer events where `address` is the `from` (topic[1]).
 */
export function buildFromTopics(addresses: string[]): [`0x${string}`, `0x${string}`[], null] {
  return [TRANSFER_TOPIC, addresses.map(padAddressToTopic), null];
}

/**
 * Builds topic filter arrays for Transfer events where `address` is the `to` (topic[2]).
 */
export function buildToTopics(addresses: string[]): [`0x${string}`, null, `0x${string}`[]] {
  return [TRANSFER_TOPIC, null, addresses.map(padAddressToTopic)];
}

/** Split an array into chunks of `size`. */
export function chunk<T>(arr: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    result.push(arr.slice(i, i + size));
  }
  return result;
}
