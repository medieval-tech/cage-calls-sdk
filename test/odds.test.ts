import { describe, expect, it } from "vitest";

import { FIGHT_BUY_STAKE, deriveFightOddsSeries } from "../src/index.js";

const STAKE = FIGHT_BUY_STAKE;
const buy = (choiceIndex: number, boughtAt: bigint) => ({ choiceIndex, boughtAt });

describe("deriveFightOddsSeries", () => {
  it("recovers the seed and replays buys in bought_at order", () => {
    // Seed 1/1/0.01, then outcome 0 bought at t=200 and outcome 1 at t=100.
    const seed = [STAKE, STAKE, STAKE / 100n];
    const series = deriveFightOddsSeries({
      buys: [buy(0, 200n), buy(1, 100n)],
      vaultNumerators: [seed[0]! + STAKE, seed[1]! + STAKE, seed[2]!],
      vaultDenominator: seed[0]! + seed[1]! + seed[2]! + 2n * STAKE,
      createdAt: 50n,
    });

    expect(series.map((point) => point.timestamp)).toEqual([50n, 100n, 200n]);
    expect(series[0]!.numerators).toEqual(seed);
    expect(series[1]!.numerators).toEqual([seed[0]!, seed[1]! + STAKE, seed[2]!]);
    expect(series[2]!.numerators).toEqual([seed[0]! + STAKE, seed[1]! + STAKE, seed[2]!]);
    expect(series[2]!.denominator).toBe(seed[0]! + seed[1]! + seed[2]! + 2n * STAKE);
    expect(series[2]!.odds[0]).toBeCloseTo(49.87, 1);
    expect(series[1]!.odds.reduce((sum, value) => sum + value, 0)).toBeCloseTo(100, 0);
  });

  it("returns only the seed point when nobody bought", () => {
    const series = deriveFightOddsSeries({
      buys: [],
      vaultNumerators: [STAKE, STAKE],
      vaultDenominator: 2n * STAKE,
      createdAt: 7n,
    });
    expect(series).toHaveLength(1);
    expect(series[0]!.timestamp).toBe(7n);
    expect(series[0]!.odds).toEqual([50, 50]);
  });

  it("refuses to build a series the vault state cannot confirm", () => {
    // Two buys claimed on an outcome whose numerator only ever received one stake.
    expect(deriveFightOddsSeries({
      buys: [buy(0, 1n), buy(0, 2n)],
      vaultNumerators: [STAKE, STAKE],
      vaultDenominator: 2n * STAKE,
      createdAt: 0n,
    })).toEqual([]);
    // Choice index outside the outcome slots.
    expect(deriveFightOddsSeries({
      buys: [buy(5, 1n)],
      vaultNumerators: [2n * STAKE, STAKE],
      vaultDenominator: 3n * STAKE,
      createdAt: 0n,
    })).toEqual([]);
    // Vault never seeded.
    expect(deriveFightOddsSeries({
      buys: [],
      vaultNumerators: [],
      vaultDenominator: 0n,
      createdAt: 0n,
    })).toEqual([]);
  });

  it("reports zero odds while the denominator is zero", () => {
    const series = deriveFightOddsSeries({
      buys: [buy(0, 10n)],
      vaultNumerators: [STAKE, 0n],
      vaultDenominator: STAKE,
      createdAt: 1n,
      stake: STAKE,
    });
    expect(series).toHaveLength(2);
    expect(series[0]!.denominator).toBe(0n);
    expect(series[0]!.odds).toEqual([0, 0]);
    expect(series[1]!.odds).toEqual([100, 0]);
  });
});
