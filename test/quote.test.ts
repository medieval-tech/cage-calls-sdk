import { beforeEach, describe, expect, it } from "vitest";

import {
  FIGHT_BUY_STAKE,
  clearLockedOddsCutoverCache,
  isLockedOddsFight,
  lockedRollBonusProbability,
  quoteFightBuy,
  resolveLockedOddsCutover,
  strikeTicketsBase,
  MAINNET_PRESET,
} from "../src/index.js";
import type { RepositoryContext } from "../src/repositories/index.js";
import { createMockRpcTransport } from "../src/testing/index.js";

const STAKE = FIGHT_BUY_STAKE;

function contextWith(rpc: ReturnType<typeof createMockRpcTransport>, now = 1_700_000_000_000): RepositoryContext {
  return { network: MAINNET_PRESET, rpc, now: () => now } as unknown as RepositoryContext;
}

describe("strikeTicketsBase", () => {
  it("floors to whole tokens and clamps to [1, 10]", () => {
    expect(strikeTicketsBase(0n)).toBe(0n);
    expect(strikeTicketsBase(1n)).toBe(1n);
    expect(strikeTicketsBase(STAKE - 1n)).toBe(1n);
    expect(strikeTicketsBase(STAKE)).toBe(1n);
    expect(strikeTicketsBase(2n * STAKE - 1n)).toBe(1n);
    expect(strikeTicketsBase(2n * STAKE)).toBe(2n);
    expect(strikeTicketsBase(11n * STAKE)).toBe(10n);
  });
});

describe("lockedRollBonusProbability", () => {
  it("mirrors the on-chain locked_roll_bonus gating", () => {
    expect(lockedRollBonusProbability(STAKE + 650_000_000_000_000_000n)).toBeCloseTo(0.65, 10);
    expect(lockedRollBonusProbability(2n * STAKE)).toBe(0);
    // Below 1.0 shares the min-1 clamp already over-pays: no bonus.
    expect(lockedRollBonusProbability(STAKE / 2n)).toBe(0);
    // At or beyond the cap: no bonus.
    expect(lockedRollBonusProbability(10n * STAKE + 1n)).toBe(0);
    expect(lockedRollBonusProbability(9n * STAKE + 500_000_000_000_000_000n)).toBeCloseTo(0.5, 10);
  });
});

describe("quoteFightBuy", () => {
  // Fresh 1:1 default market: seed ≈ 0.9995 per side, D = 2.
  const numerators = [999_500_249_875_062_468n, 999_500_249_875_062_468n, 999_500_249_875_064n];
  const denominator = 2n * STAKE;

  it("locked odds: the quote is the contract payout", () => {
    const quote = quoteFightBuy({ vaultNumerators: numerators, vaultDenominator: denominator, outcomeIndex: 0, lockedOdds: true });
    expect(quote.shares).toBe((STAKE * denominator) / numerators[0]!);
    expect(quote.claimable).toBe(quote.shares);
    expect(quote.baseTickets).toBe(2n);
    expect(quote.bonusProbability).toBeCloseTo(Number(quote.shares % STAKE) / 1e18, 10);
    expect(quote.guaranteed).toBe(true);
  });

  it("legacy: estimates the renormalized claim assuming no later buys", () => {
    const quote = quoteFightBuy({
      vaultNumerators: numerators,
      vaultDenominator: denominator,
      outcomeIndex: 0,
      lockedOdds: false,
      outcomeShares: [0n, 0n, 0n],
    });
    // Sole winner takes the whole (pot + own stake): claimable = D + stake = 3.
    expect(quote.claimable).toBe(((quote.shares) * (denominator + STAKE)) / quote.shares);
    expect(quote.baseTickets).toBe(3n);
    expect(quote.bonusProbability).toBe(0);
    expect(quote.guaranteed).toBe(false);
  });

  it("mirrors buy_fight for an empty side: shares = stake", () => {
    const quote = quoteFightBuy({ vaultNumerators: [0n, STAKE], vaultDenominator: STAKE, outcomeIndex: 0, lockedOdds: true });
    expect(quote.shares).toBe(STAKE);
    expect(quote.baseTickets).toBe(1n);
    expect(quote.bonusProbability).toBe(0);
  });
});

describe("isLockedOddsFight", () => {
  it("treats an unset cutover as legacy everywhere", () => {
    expect(isLockedOddsFight(0n, 1n)).toBe(false);
    expect(isLockedOddsFight(0n, 10_000n)).toBe(false);
    expect(isLockedOddsFight(98n, 97n)).toBe(false);
    expect(isLockedOddsFight(98n, 98n)).toBe(true);
    expect(isLockedOddsFight(1n, 1n)).toBe(true);
  });
});

describe("resolveLockedOddsCutover", () => {
  beforeEach(() => clearLockedOddsCutoverCache());

  it("reads the cutover from the chain and caches a non-zero value", async () => {
    const rpc = createMockRpcTransport({ calls: { locked_odds_cutover: ["0x62", "0x0"] } });
    const context = contextWith(rpc);
    expect(await resolveLockedOddsCutover(context)).toBe(0x62n);
    expect(await resolveLockedOddsCutover(context)).toBe(0x62n);
    expect(rpc.calls).toHaveLength(1);
  });

  it("treats a missing view (pre-upgrade class) as legacy math", async () => {
    const rpc = createMockRpcTransport();
    expect(await resolveLockedOddsCutover(contextWith(rpc))).toBe(0n);
  });

  it("re-checks an inactive cutover after the TTL", async () => {
    let value: readonly string[] = ["0x0", "0x0"];
    const rpc = createMockRpcTransport({ calls: { locked_odds_cutover: () => value } });
    let now = 1_700_000_000_000;
    const context = { network: MAINNET_PRESET, rpc, now: () => now } as unknown as RepositoryContext;
    expect(await resolveLockedOddsCutover(context)).toBe(0n);
    expect(await resolveLockedOddsCutover(context)).toBe(0n);
    expect(rpc.calls).toHaveLength(1);
    value = ["0x63", "0x0"];
    now += 600_000;
    expect(await resolveLockedOddsCutover(context)).toBe(0x63n);
    expect(rpc.calls).toHaveLength(2);
  });
});
