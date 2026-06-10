/**
 * Returns the delay in ms for attempt N using exponential backoff.
 * Caps at `cap` ms.
 */
export function backoffMs(attempt: number, initial = 1_000, cap = 30_000): number {
  return Math.min(initial * 2 ** attempt, cap);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
