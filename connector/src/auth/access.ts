// Service token access values and their order. Kept free of runtime imports (no OAuth provider,
// no D1) so tool modules can rank access without pulling the Worker-only provider into bundles
// built outside workerd, such as scripts/bench-suggest-links.mjs.

export type ServiceTokenAccess = "read" | "write-no-delete" | "write";

/**
 * The order of the access values, defined only here (spec 2026-11-08-service-token-write-no-delete
 * §3.2): `read` < `write-no-delete` < `write`. A higher rank may do everything a lower one may.
 */
export const MODE_RANK = { read: 0, "write-no-delete": 1, write: 2 } as const;

/** The rank of `access`. Throws for anything that is not a MODE_RANK key, so an unknown value never ranks. */
export function rank(access: ServiceTokenAccess): number {
  if (!Object.hasOwn(MODE_RANK, access)) throw new Error(`unknown service token access '${access}'`);
  return MODE_RANK[access];
}

/**
 * The access values a token may authenticate with: every MODE_RANK key. Anything else, a value
 * written past the CHECK included, is refused, so an unknown access fails closed rather than acting
 * as write. The wizard's forms accept the same values.
 */
export function acceptedAccess(access: unknown): access is ServiceTokenAccess {
  return typeof access === "string" && Object.hasOwn(MODE_RANK, access);
}
