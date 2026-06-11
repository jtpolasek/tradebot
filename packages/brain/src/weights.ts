export function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

export function computeZScore(value: number, cohort: number[]): number {
  if (cohort.length <= 1) return 0;
  const mean = cohort.reduce((s, v) => s + v, 0) / cohort.length;
  const variance = cohort.reduce((s, v) => s + (v - mean) ** 2, 0) / cohort.length;
  const std = Math.sqrt(variance);
  if (std < 1e-10) return 0;
  return (value - mean) / std;
}

export function computeScore(
  pnlZ: number,
  winRateZ: number,
  avgReturnZ: number,
  drawdownZ: number
): number {
  return 0.35 * pnlZ + 0.25 * winRateZ + 0.25 * avgReturnZ - 0.15 * drawdownZ;
}

export function scoreToWeight(score: number): number {
  const raw = 2 * sigmoid(score);
  return Math.max(0, Math.min(2, raw));
}

export function shouldAutoMute(score7d: number | null): boolean {
  return score7d !== null && score7d < -1;
}
