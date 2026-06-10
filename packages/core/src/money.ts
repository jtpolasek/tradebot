export function formatUsd(value: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: Math.abs(value) >= 100 ? 2 : 4
  }).format(Number.isFinite(value) ? value : 0);
}

export function formatUsdPrice(value: number) {
  const safeValue = Number.isFinite(value) ? value : 0;
  if (safeValue === 0) return "$0.00";

  const abs = Math.abs(safeValue);
  if (abs >= 1) return formatUsd(safeValue);
  if (abs >= 0.0001) {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      minimumFractionDigits: 4,
      maximumFractionDigits: 6
    }).format(safeValue);
  }

  return `$${safeValue.toPrecision(4)}`;
}

export function formatNumber(value: number, digits = 4) {
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: digits
  }).format(Number.isFinite(value) ? value : 0);
}

export function toBaseUnits(amount: number, decimals: number): string {
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error("Amount must be greater than zero.");
  }
  const [whole, fraction = ""] = amount.toString().split(".");
  const padded = (fraction + "0".repeat(decimals)).slice(0, decimals);
  return BigInt(whole + padded).toString();
}

export function fromBaseUnits(raw: string | number | bigint, decimals: number): number {
  const value = BigInt(raw);
  const divisor = 10n ** BigInt(decimals);
  const whole = value / divisor;
  const fraction = value % divisor;
  const fractionText = fraction.toString().padStart(decimals, "0").replace(/0+$/, "");
  return Number(`${whole.toString()}${fractionText ? `.${fractionText}` : ""}`);
}

export function normalizeAddress(address: string): string {
  const trimmed = address.trim();
  if (!/^0x[a-fA-F0-9]{40}$/.test(trimmed)) {
    throw new Error("Enter a valid Ethereum address.");
  }
  return trimmed.toLowerCase();
}

export function normalizeAddressInput(input: string): string {
  const trimmed = input.trim();
  const directAddress = /^0x[a-fA-F0-9]{40}$/.exec(trimmed);
  if (directAddress) return directAddress[0].toLowerCase();

  const embeddedAddress = /0x[a-fA-F0-9]{40}/.exec(trimmed);
  if (embeddedAddress) return embeddedAddress[0].toLowerCase();

  throw new Error("Enter a valid Ethereum address or GMGN wallet URL.");
}
