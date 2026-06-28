import type { Nomination, Nominator } from "./nominator.js";

export interface CompositeNominatorOptions {
  nominators: Nominator[];
}

/**
 * Runs multiple discovery sources and returns one nomination per wallet. First source wins for
 * numeric snapshot fields because each nominator owns only proposal metadata; evaluation recomputes
 * quality before promotion.
 */
export function createCompositeNominator(opts: CompositeNominatorOptions): Nominator {
  return {
    async nominate(): Promise<Nomination[]> {
      const batches = await Promise.all(opts.nominators.map((nominator) => nominator.nominate()));
      const byAddress = new Map<string, Nomination>();

      for (const nomination of batches.flat()) {
        const address = nomination.address.toLowerCase();
        const existing = byAddress.get(address);
        if (!existing) {
          byAddress.set(address, { ...nomination, address });
          continue;
        }

        byAddress.set(address, {
          ...existing,
          source: mergeSources(existing.source, nomination.source),
          corroborated: Boolean(existing.corroborated || nomination.corroborated),
        });
      }

      return [...byAddress.values()];
    },
  };
}

function mergeSources(a: string, b: string): string {
  const sources = new Set(
    [...a.split(","), ...b.split(",")]
      .map((source) => source.trim())
      .filter((source) => source.length > 0),
  );
  return [...sources].join(",");
}
