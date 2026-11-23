import { describe, expect, it } from "vitest";

import {
  createCageCallsClient,
  filterRelicCollection,
  SEPOLIA_DEV_PRESET,
  summarizeAnalyticsSnapshot,
  summarizeRelicCollection,
  type Address,
  type AnalyticsSnapshot,
  type Fight,
  type Relic,
} from "../src/index.js";
import { createMockRpcTransport } from "../src/testing/index.js";
import { encodeRelicRows, metadataFixture } from "./fixtures.js";

const owner = "0x123" as Address;

function relic(tokenId: bigint, input: Partial<ReturnType<typeof metadataFixture>> = {}, definitionId = tokenId): Relic {
  const metadata = { ...metadataFixture(tokenId), definitionId, ...input };
  return { tokenId, definitionId, editionNumber: tokenId, metadata, attributes: [] };
}

function fight(input: Partial<Fight> = {}): Fight {
  return {
    fightId: 1n,
    seasonId: 1n,
    eventName: "Event A",
    marketId: 10n,
    fighterAId: 1n,
    fighterAName: "Alice",
    fighterAWeightClass: "Lightweight",
    choiceAValue: 1n,
    choiceALabel: "Alice",
    fighterBId: 2n,
    fighterBName: "Bob",
    fighterBWeightClass: "Lightweight",
    choiceBValue: 2n,
    choiceBLabel: "Bob",
    createdAt: 100n,
    isDev: false,
    sponsor: "0x0",
    ...input,
  };
}

describe("relic collection statistics", () => {
  it("exposes minted and unique-definition views across every requested dimension", () => {
    const stats = summarizeRelicCollection([
      relic(1n, { fighterId: 1n, rarity: 0, moveType: "Sword Strike", power: 8 }, 100n),
      relic(2n, { fighterId: 1n, rarity: 0, moveType: "sword-strike", power: 8 }, 100n),
      relic(3n, { fighterId: 2n, rarity: 3, moveType: "throw", power: 4 }, 200n),
    ], {}, [
      { fighterId: 1n, name: "Alice", weightClass: "Lightweight", active: true },
      { fighterId: 2n, name: "Bob", weightClass: "Welterweight", active: true },
    ]);

    expect(stats.minted.count).toBe(3);
    expect(stats.definitions.count).toBe(2);
    expect(stats.minted.byMoveType).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: "sword_strike", count: 2 }),
      expect.objectContaining({ key: "throw", count: 1 }),
    ]));
    expect(stats.minted.byMoveType[0]?.percentage).toBeCloseTo(200 / 3);
    expect(stats.definitions.averages.power).toBe(6);
    expect(stats.definitions.byFighter[0]).toMatchObject({ key: "alice", label: "Alice", count: 1 });
    expect(stats.minted.byRarityTier.map((entry) => [entry.key, entry.count])).toEqual([["common", 2], ["rare", 1]]);
  });

  it("combines dimensions with AND semantics and preserves full collection facets", () => {
    const values = [
      relic(1n, { fighterId: 1n, rarity: 0, moveType: "sword_strike" }),
      relic(2n, { fighterId: 1n, rarity: 3, moveType: "throw" }),
      relic(3n, { fighterId: 2n, rarity: 0, moveType: "takedown" }),
    ];
    const stats = summarizeRelicCollection(values, { fighterIds: [1n], rarityTiers: ["common"] });

    expect(stats.minted.count).toBe(1);
    expect(stats.minted.byMoveType[0]?.key).toBe("sword_strike");
    expect(stats.facets.fighters).toHaveLength(2);
    expect(stats.facets.moveTypes).toHaveLength(3);
    expect(filterRelicCollection(values, { fighterIds: [1n], rarityTiers: ["common"] }).map((value) => value.tokenId)).toEqual([1n]);
  });

  it("keeps metadata-less relics visible in coverage instead of silently counting them", () => {
    const stats = summarizeRelicCollection([{ tokenId: 1n, attributes: [] }, relic(2n)]);
    expect(stats.coverage).toMatchObject({ inventoryCount: 2, metadataCount: 1, missingMetadata: 1 });
    expect(stats.minted.count).toBe(1);
  });

  it("derives collection statistics directly from complete Torii token attributes", () => {
    const indexed = (tokenId: bigint, edition: number): Relic => ({
      tokenId,
      name: `Common 3 — Leg Strikes #${edition}`,
      image: `ipfs://image-${tokenId}`,
      attributes: [
        { traitType: "Rarity", value: "Common 3" },
        { traitType: "Move Type", value: "Sword Strike" },
        { traitType: "Move Name", value: "Leg Strikes" },
        { traitType: "Fighter", value: "Alice" },
        { traitType: "Opponent", value: "Bob" },
        { traitType: "Season", value: "Season 1" },
        { traitType: "Fight", value: "Fight #25" },
        { traitType: "Edition", value: edition },
        { traitType: "Power", value: 8 },
        { traitType: "Speed", value: 7 },
        { traitType: "Control", value: 6 },
        { traitType: "Risk", value: 5 },
        { traitType: "Complexity", value: 4 },
        { traitType: "Versatility", value: 3 },
      ],
      metadataSources: ["torii"],
    });
    const fighters = [{ fighterId: 1n, name: "Alice", weightClass: "Lightweight", active: true }];
    const relics = [indexed(1n, 1), indexed(2n, 2)];

    const stats = summarizeRelicCollection(relics, { fighterKeys: ["Alice"] }, fighters);

    expect(stats.coverage).toMatchObject({
      inventoryCount: 2,
      metadataCount: 2,
      indexedMetadataCount: 2,
      rpcHydratedCount: 0,
      missingMetadata: 0,
    });
    expect(stats.minted).toMatchObject({ count: 2, averages: { power: 8, speed: 7 } });
    expect(stats.minted.byFighter[0]).toMatchObject({ key: "alice", label: "Alice", count: 2 });
    expect(stats.minted.byMoveType[0]).toMatchObject({ key: "sword_strike", count: 2 });
    expect(stats.definitions.count).toBe(1);
    expect(filterRelicCollection(relics, { fighterKeys: ["alice"] }, fighters)).toHaveLength(2);
  });

  it("paginates the full authoritative collection through the aggregate RPC feed", async () => {
    const rpc = createMockRpcTransport({
      calls: {
        get_relic_feed: (request) => {
          const cursor = BigInt(request.calldata?.[0] ?? "0");
          return encodeRelicRows([{ tokenId: cursor === 0n ? 2n : 1n, owner }]);
        },
      },
    });
    const client = createCageCallsClient({ network: SEPOLIA_DEV_PRESET, transports: { rpc } });

    const response = await client.relics.collection({ pageSize: 1, enrichFighters: false });

    expect(response.data.items.map((item) => item.tokenId)).toEqual([2n, 1n]);
    expect(response.data.pageCount).toBe(2);
    expect(response.meta.complete).toBe(false);
  });
});

describe("Cage Calls market summaries", () => {
  it("counts collateral volume as stake per prediction and derives wallet, outcome, day, fight, and event metrics", () => {
    const first = fight();
    const second = fight({ fightId: 2n, marketId: 20n, eventName: "Event B", createdAt: 200n });
    const snapshot: AnalyticsSnapshot = {
      fights: [first, second],
      buys: [
        { fightId: 1n, buyer: "0xa", choiceIndex: 0, boughtAt: 1_700_000_000n },
        { fightId: 1n, buyer: "0xb", choiceIndex: 1, boughtAt: 1_700_000_100n },
        { fightId: 2n, buyer: "0xa", choiceIndex: 0, boughtAt: 1_700_086_400n },
      ],
      winnerChoiceByFight: { "1": 0 },
    };

    const summary = summarizeAnalyticsSnapshot(snapshot, { productionOnly: true });

    expect(summary.metrics).toMatchObject({ predictions: 3, uniqueWallets: 2, repeatWallets: 1, correct: 1, wrong: 1, unresolved: 1 });
    // FightBuy.amount stores locked-odds shares; deposited collateral is the
    // fixed stake per prediction.
    expect(summary.metrics.volume).toBe(3_000_000_000_000_000_000n);
    expect(summary.daily).toHaveLength(2);
    expect(summary.fights).toHaveLength(2);
    expect(summary.events.map((event) => event.eventName)).toEqual(["Event A", "Event B"]);
  });

  it("splits returning wallets into any-earlier-event and immediately-previous-event", () => {
    const snapshot: AnalyticsSnapshot = {
      fights: [
        fight(),
        fight({ fightId: 2n, marketId: 20n, eventName: "Event B", createdAt: 200n }),
        fight({ fightId: 3n, marketId: 30n, eventName: "Event C", createdAt: 300n }),
      ],
      buys: [
        { fightId: 1n, buyer: "0xa", choiceIndex: 0, boughtAt: 100n },
        { fightId: 1n, buyer: "0xb", choiceIndex: 0, boughtAt: 101n },
        { fightId: 2n, buyer: "0xb", choiceIndex: 0, boughtAt: 200n },
        { fightId: 2n, buyer: "0xc", choiceIndex: 0, boughtAt: 201n },
        { fightId: 3n, buyer: "0xa", choiceIndex: 0, boughtAt: 300n },
        { fightId: 3n, buyer: "0xb", choiceIndex: 0, boughtAt: 301n },
        { fightId: 3n, buyer: "0xd", choiceIndex: 0, boughtAt: 302n },
      ],
      winnerChoiceByFight: {},
    };

    const [a, b, c] = summarizeAnalyticsSnapshot(snapshot, { productionOnly: true }).events;

    expect(a).toMatchObject({ uniqueWallets: 2, returningWallets: 0, returningFromPreviousWallets: 0, newWallets: 2 });
    expect(b).toMatchObject({ uniqueWallets: 2, returningWallets: 1, returningFromPreviousWallets: 1, newWallets: 1 });
    expect(c).toMatchObject({ uniqueWallets: 3, returningWallets: 2, returningFromPreviousWallets: 1, newWallets: 1 });
  });

  it("compares with the event right before, even when it has no predictions in range", () => {
    const snapshot: AnalyticsSnapshot = {
      fights: [
        fight(),
        fight({ fightId: 2n, marketId: 20n, eventName: "Event B", createdAt: 200n }),
        fight({ fightId: 3n, marketId: 30n, eventName: "Event C", createdAt: 300n }),
      ],
      buys: [
        { fightId: 1n, buyer: "0xa", choiceIndex: 0, boughtAt: 100n },
        { fightId: 2n, buyer: "0xa", choiceIndex: 0, boughtAt: 50n },
        { fightId: 3n, buyer: "0xa", choiceIndex: 0, boughtAt: 300n },
      ],
      winnerChoiceByFight: {},
    };

    const unfiltered = summarizeAnalyticsSnapshot(snapshot).events;
    expect(unfiltered.map((event) => [event.eventName, event.returningFromPreviousWallets])).toEqual([
      ["Event A", 0],
      ["Event B", 1],
      ["Event C", 1],
    ]);

    const windowed = summarizeAnalyticsSnapshot(snapshot, { from: 100n }).events;
    expect(windowed.map((event) => [event.eventName, event.returningWallets, event.returningFromPreviousWallets])).toEqual([
      ["Event A", 0, 0],
      ["Event C", 1, 0],
    ]);
  });

  it("orders events created at the same time by their first fight", () => {
    const snapshot: AnalyticsSnapshot = {
      fights: [
        fight({ fightId: 1n, eventName: "Zeta", createdAt: 100n }),
        fight({ fightId: 2n, marketId: 20n, eventName: "Alpha", createdAt: 100n }),
      ],
      buys: [
        { fightId: 1n, buyer: "0xa", choiceIndex: 0, boughtAt: 100n },
        { fightId: 2n, buyer: "0xa", choiceIndex: 0, boughtAt: 101n },
      ],
      winnerChoiceByFight: {},
    };

    expect(summarizeAnalyticsSnapshot(snapshot).events.map((event) => [event.eventName, event.returningFromPreviousWallets])).toEqual([
      ["Zeta", 0],
      ["Alpha", 1],
    ]);
  });

  it("applies time and domain filters before calculating summaries", () => {
    const snapshot: AnalyticsSnapshot = {
      fights: [fight(), fight({ fightId: 2n, marketId: 20n, eventName: "Event B" })],
      buys: [
        { fightId: 1n, buyer: "0xa", choiceIndex: 0, boughtAt: 100n },
        { fightId: 2n, buyer: "0xb", choiceIndex: 0, boughtAt: 200n },
      ],
      winnerChoiceByFight: {},
    };

    const summary = summarizeAnalyticsSnapshot(snapshot, { from: 150n, eventNames: ["Event B"] });
    expect(summary.metrics).toMatchObject({ predictions: 1, uniqueWallets: 1, volume: 1_000_000_000_000_000_000n });
    expect(summary.includedFights.map((value) => value.fightId)).toEqual([2n]);
  });
});
