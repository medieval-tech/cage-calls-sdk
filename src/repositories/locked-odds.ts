import { decodeSingleU256 } from "../core/decoders.js";
import type { RequestOptions } from "../core/types.js";
import type { RepositoryContext } from "./index.js";

interface CutoverCacheEntry {
  value: bigint;
  fetchedAt: number;
}

// Keyed by chain + FightFactory address. The cutover is set once on-chain and
// never changes after that, so a non-zero value caches forever; zero (not yet
// activated, or a pre-upgrade class without the view) re-checks on a TTL so a
// running app picks the activation up without a reload.
const CUTOVER_CACHE = new Map<string, CutoverCacheEntry>();
const INACTIVE_TTL_MS = 300_000;

export function clearLockedOddsCutoverCache(): void {
  CUTOVER_CACHE.clear();
}

// A missing entrypoint is the one error that PROVES a legacy (pre-upgrade)
// class; anything else — abort, timeout, transport failure — says nothing
// about the chain and must not be cached, or one aborted read poisons every
// snapshot into legacy math for the whole TTL. The transport wraps the raw
// node error as "RPC request failed (RPC_21)." — 21 is the JSON-RPC code for
// a missing entrypoint — so match both the wrapped code and the raw text.
function isEntrypointMissing(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  if (/\bRPC_21\b/.test(message)) return true;
  return /entrypoint/i.test(message) && /(not found|does not exist|ENTRYPOINT_NOT_FOUND)/i.test(message);
}

/**
 * First fight id that pays locked odds on this network, straight from the
 * chain (`FightFactory.locked_odds_cutover`). Returns 0n while locked odds are
 * inactive — including on deployments whose class predates the view, which is
 * exactly the legacy behavior those deployments have. Transient read failures
 * also return 0n but are never cached: the next read retries the chain.
 */
export async function resolveLockedOddsCutover(
  context: RepositoryContext,
  options?: RequestOptions,
): Promise<bigint> {
  const key = `${context.network.chainId}:${context.network.contracts.FightFactory}`;
  const cached = CUTOVER_CACHE.get(key);
  if (cached && (cached.value !== 0n || context.now() - cached.fetchedAt < INACTIVE_TTL_MS)) {
    return cached.value;
  }
  let value = 0n;
  try {
    const result = await context.rpc.call(
      { contractAddress: context.network.contracts.FightFactory, entrypoint: "locked_odds_cutover", calldata: [] },
      options,
    );
    value = decodeSingleU256(result.data, "lockedOddsCutover");
  } catch (error) {
    if (!isEntrypointMissing(error)) {
      context.logger?.warn?.("locked_odds_cutover read failed transiently; using legacy math for this read only.", {
        error: error instanceof Error ? error.message : String(error),
      });
      return value;
    }
    context.logger?.debug?.("locked_odds_cutover entrypoint missing (pre-upgrade class); legacy math.", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
  CUTOVER_CACHE.set(key, { value, fetchedAt: context.now() });
  return value;
}

/** Whether `fightId` pays locked odds given the on-chain cutover (0 = inactive). */
export function isLockedOddsFight(cutover: bigint, fightId: bigint): boolean {
  return cutover !== 0n && fightId >= cutover;
}
