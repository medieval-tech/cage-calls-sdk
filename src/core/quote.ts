import { FIGHT_BUY_STAKE } from "./odds.js";

const SCALE = 1_000_000_000_000_000_000n;

/**
 * The strike-ticket clamp shared with `fight_factory.cairo`'s
 * `strike_tickets_amount`: floor to whole tokens, minimum 1, maximum 10.
 */
export function strikeTicketsBase(claimable: bigint): bigint {
  if (claimable <= 0n) return 0n;
  const whole = claimable / SCALE;
  const amount = whole === 0n ? 1n : whole;
  return amount > 10n ? 10n : amount;
}

/**
 * Probability (0..1) that `redeem_with_roll` mints one bonus ticket for a
 * locked-odds position holding `shares`. Mirrors `locked_roll_bonus` on-chain:
 * no bonus below 1.0 shares (the min-1 clamp already over-pays those) or at the
 * 10-ticket cap.
 */
export function lockedRollBonusProbability(shares: bigint): number {
  const whole = shares / SCALE;
  if (whole === 0n || whole >= 10n) return 0;
  return Number(shares % SCALE) / 1e18;
}

export interface FightBuyQuote {
  /** Locked shares received for the fixed stake, in collateral wei (D/N before the bet). */
  shares: bigint;
  /** Claimable amount the ticket math runs on, in collateral wei. */
  claimable: bigint;
  /** Tickets minted by plain `redeem` if this side wins. */
  baseTickets: bigint;
  /** Probability of one extra ticket via `redeem_with_roll` (locked-odds fights only). */
  bonusProbability: number;
  /**
   * True when the numbers are a contract guarantee (locked-odds fight: what you
   * see is what redeem pays). False for a legacy fight, where the value is a
   * "no bets after mine" estimate that drifts with every later buy.
   */
  guaranteed: boolean;
}

export interface QuoteFightBuyInput {
  /** Current vault numerators, one entry per outcome slot. */
  vaultNumerators: readonly bigint[];
  /** Current vault denominator. */
  vaultDenominator: bigint;
  /** Side being quoted (0 = A, 1 = B). */
  outcomeIndex: number;
  /**
   * Whether the fight pays locked odds (`fight_id >=` the on-chain cutover).
   * Use `FightFeedItem.lockedOdds` or `resolveLockedOddsCutover`.
   */
  lockedOdds: boolean;
  /** Σ FightBuy shares per outcome. Required for the legacy estimate; unused for locked odds. */
  outcomeShares?: readonly bigint[];
  /** Stake per buy; defaults to the on-chain fixed 1-token stake. */
  stake?: bigint;
}

/**
 * Quote a fight buy: the locked shares and strike tickets for betting `stake`
 * on `outcomeIndex` right now. The share formula mirrors `buy_fight` exactly
 * (pre-bet vault state; a side with an empty numerator locks `stake`).
 *
 * Locked-odds fights make this a promise: `redeem` pays `baseTickets` and
 * `redeem_with_roll` adds one more with `bonusProbability`. Legacy fights get
 * the "no bets after mine" estimate (shares × (D+stake) / (Σ winner shares +
 * shares)) with no roll.
 */
export function quoteFightBuy(input: QuoteFightBuyInput): FightBuyQuote {
  const stake = input.stake ?? FIGHT_BUY_STAKE;
  const numerator = input.vaultNumerators[input.outcomeIndex] ?? 0n;
  const denominator = input.vaultDenominator;
  const shares = numerator > 0n ? (stake * denominator) / numerator : stake;

  if (input.lockedOdds) {
    return {
      shares,
      claimable: shares,
      baseTickets: strikeTicketsBase(shares),
      bonusProbability: lockedRollBonusProbability(shares),
      guaranteed: true,
    };
  }

  const existingShares = input.outcomeShares?.[input.outcomeIndex] ?? 0n;
  const potAfterBuy = denominator + stake;
  const projectedWinnerShares = existingShares + shares;
  const claimable = projectedWinnerShares > 0n ? (shares * potAfterBuy) / projectedWinnerShares : shares;
  return {
    shares,
    claimable,
    baseTickets: strikeTicketsBase(claimable),
    bonusProbability: 0,
    guaranteed: false,
  };
}
