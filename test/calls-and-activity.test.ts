import { describe, expect, it } from "vitest";

import {
  createCallBuilders,
  createFightEventsRepository,
  decodeActivity,
  MAINNET_PRESET,
  type FightFeedItem,
  type FightsRepository,
  type RepositoryContext,
} from "../src/index.js";
import { createMockRpcTransport } from "../src/testing.js";

const fight = (seasonId: bigint, fightId: bigint): FightFeedItem => ({
  fightId,
  seasonId,
  eventName: "Cage Night",
  marketId: fightId,
  fighterAId: 1n,
  fighterAName: "A",
  fighterAWeightClass: "Welterweight",
  choiceAValue: 1n,
  choiceALabel: "A",
  fighterBId: 2n,
  fighterBName: "B",
  fighterBWeightClass: "Welterweight",
  choiceBValue: 2n,
  choiceBLabel: "B",
  createdAt: 1n,
  isDev: false,
  sponsor: "0x0",
  marketCreatedAt: 1n,
  conditionId: fightId,
  oracle: "0x1",
  outcomeSlotCount: 2,
  collateralToken: "0x2",
  startAt: 10n,
  endAt: 20n,
  resolveAt: 30n,
  resolvedAt: 0n,
  vaultNumerators: [1n, 1n],
  vaultDenominator: 2n,
  outcomeCounts: [0n, 0n],
  outcomeShares: [0n, 0n],
  payoutNumerators: [0n, 0n],
  payoutDenominator: 0n,
  pot: { total: 0n, claimed: 0n, winnersCount: 0n, closed: false, settled: false },
  viewer: { hasBought: false, shares: 0n, boughtAt: 0n, hasRedeemed: false, isWinner: false, strikeTickets: 0n },
});

describe("call plans and activity", () => {
  const calls = createCallBuilders(MAINNET_PRESET);

  it("builds VRF + approval + strike without executing", () => {
    const response = calls.gacha.strike(7n, "0xabc");
    expect(response.calls.map((value) => value.entrypoint)).toEqual([
      "request_random",
      "set_approval_for_all",
      "strike",
    ]);
    expect(response.requirements).toEqual({ controller: true, vrf: true, tokenApproval: true });
  });

  it("keep invalidates both gacha and owned relic data", () => {
    const response = calls.gacha.keep(7n, "0x123");
    expect(response.invalidate).toContainEqual(["cage-calls", "gacha", "7"]);
    expect(response.invalidate).toContainEqual(["cage-calls", "owned-relics", "0x123"]);
  });

  it("preserves unknown activity as a raw event", () => {
    const activity = decodeActivity("mainnet", {
      selector: "0x123",
      contract: MAINNET_PRESET.worldAddress,
      keys: ["0x123"],
      data: ["0x456"],
      raw: { future: true },
    });
    expect(activity.type).toBe("unknown");
    expect(activity.raw.raw).toEqual({ future: true });
  });

  it("keeps identically named events in different seasons separate", async () => {
    const feedItems = [fight(1n, 1n), fight(2n, 2n)];
    const fights = {
      feed: async () => ({
        data: { items: feedItems, hasMore: false },
        meta: { source: "starknet-rpc" as const, complete: true, attempts: [], warnings: [], fetchedAt: 0, durationMs: 0 },
      }),
    } as unknown as FightsRepository;
    const context = {
      network: MAINNET_PRESET,
      rpc: createMockRpcTransport(),
      capabilities: { has: () => false, probe: async () => false, snapshot: () => MAINNET_PRESET.capabilities },
      budget: { timeoutMs: 1, maxConcurrency: 1, maxRpcPages: 1, maxRpcItems: 1, maxToriiPages: 1, maxAlchemyPages: 1, pageSize: 1 },
      now: () => 15_000,
    } satisfies RepositoryContext;
    const response = await createFightEventsRepository(context, fights).list({ now: 15n });
    expect(response.data.items.map((event) => event.seasonId)).toEqual([1n, 2n]);
    expect(response.data.items).toHaveLength(2);
  });
});
