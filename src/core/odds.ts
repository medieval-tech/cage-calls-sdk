import type { FightBuy, FightOddsPoint } from "./types.js";

/**
 * Collateral pulled into the vault by every fight buy. Mirrors the fixed
 * 1-token stake hardcoded in `fight_factory.cairo`'s `buy_fight`. Note that
 * `FightBuy.amount` stores locked-odds shares, not this deposit — the vault
 * numerator and denominator each move by exactly this constant per buy.
 */
export const FIGHT_BUY_STAKE = 1_000_000_000_000_000_000n;

export interface FightOddsSeriesInput {
  /** Every buy on the fight. One buy per wallet on-chain, so this is the full timeline. */
  buys: readonly Pick<FightBuy, "choiceIndex" | "boughtAt">[];
  /** Current vault numerators, one entry per outcome slot. */
  vaultNumerators: readonly bigint[];
  /** Current vault denominator. */
  vaultDenominator: bigint;
  /** Fight creation timestamp (unix seconds), anchors the seed point. */
  createdAt: bigint;
  /** Vault contribution per buy; defaults to the on-chain fixed stake. */
  stake?: bigint;
}

function oddsOf(numerators: readonly bigint[], denominator: bigint): number[] {
  return numerators.map((value) => denominator > 0n ? Number((value * 10_000n) / denominator) / 100 : 0);
}

/**
 * Rebuild the odds-over-time series for a fight from its buy timeline and the
 * current vault state. Exact by construction: fees are zero on-chain, every buy
 * adds the fixed stake to its outcome's numerator and to the denominator, and
 * redemption never writes the vault — so walking back from the current state
 * recovers the creation-time seed, and replaying the buys forward reproduces
 * every intermediate state.
 *
 * Returns the seed point followed by one point per buy in `bought_at` order.
 * Returns an empty series when the inputs cannot have produced the current
 * vault state (incomplete buy list, out-of-range choice, empty vault).
 */
export function deriveFightOddsSeries(input: FightOddsSeriesInput): FightOddsPoint[] {
  const stake = input.stake ?? FIGHT_BUY_STAKE;
  const outcomeCount = input.vaultNumerators.length;
  if (outcomeCount === 0 || input.vaultDenominator <= 0n) return [];

  const buys = [...input.buys].sort((a, b) => (a.boughtAt < b.boughtAt ? -1 : a.boughtAt > b.boughtAt ? 1 : 0));
  const numerators = [...input.vaultNumerators];
  let denominator = input.vaultDenominator;
  for (const buy of buys) {
    const value = numerators[buy.choiceIndex];
    if (value === undefined) return [];
    numerators[buy.choiceIndex] = value - stake;
    denominator -= stake;
  }
  if (denominator < 0n || numerators.some((value) => value < 0n)) return [];

  const points: FightOddsPoint[] = [{
    timestamp: input.createdAt,
    numerators: [...numerators],
    denominator,
    odds: oddsOf(numerators, denominator),
  }];
  for (const buy of buys) {
    numerators[buy.choiceIndex] = (numerators[buy.choiceIndex] ?? 0n) + stake;
    denominator += stake;
    points.push({
      timestamp: buy.boughtAt,
      numerators: [...numerators],
      denominator,
      odds: oddsOf(numerators, denominator),
    });
  }
  return points;
}
