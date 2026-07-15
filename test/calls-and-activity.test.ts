import { describe, expect, it } from "vitest";

import {
  createActivityRepository,
  createFightEventsRepository,
  createFightsRepository,
  decodeActivity,
  encodeByteArray,
  encodeU256,
  MAINNET_PRESET,
  type FightFeedItem,
  type FightsRepository,
  type RepositoryContext,
  type RequestOptions,
  type ToriiModelRequest,
} from "../src/index.js";
import { createMockRpcTransport, createMockToriiTransport } from "../src/testing.js";

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

describe("activity", () => {
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

  it("decodes registered Dojo events through the EventEmitted wrapper", () => {
    const activity = decodeActivity("sepolia-dev", {
      selector: "0x1c93f6e4703ae90f75338f29bffbe9c1662200cee981f49afeec26e892debcd",
      contract: MAINNET_PRESET.worldAddress,
      keys: [
        "0x1c93f6e4703ae90f75338f29bffbe9c1662200cee981f49afeec26e892debcd",
        "0x59cd6e838e5a04ad17b8dca262ade7c17dcfdbc78044b478d6a70f46ffbd5a4",
        "0x123",
      ],
      data: ["0x456"],
      raw: {},
    });

    expect(activity.type).toBe("market-lifecycle");
    expect(activity.payload).toEqual({
      eventName: "MarketCreated",
      keys: ["0x123"],
      data: ["0x456"],
    });
  });

  it("decodes block, transaction, and emitting contract from Torii event IDs", async () => {
    const contract = "0x789";
    const transactionHash = "0x456";
    const context = {
      network: MAINNET_PRESET,
      rpc: createMockRpcTransport(),
      torii: createMockToriiTransport({ events: {
        edges: [{ cursor: "event-1", node: {
          id: `0x123:${transactionHash}:${contract}:0x0`,
          keys: ["0xabc"],
          data: ["0xdef"],
          executedAt: "2026-07-14T08:00:00+00:00",
        } }],
        totalCount: 1,
        pageInfo: { hasNextPage: false },
      } }),
      capabilities: { has: () => false, probe: async () => false, snapshot: () => MAINNET_PRESET.capabilities },
      budget: { timeoutMs: 1, maxConcurrency: 1, maxRpcPages: 1, maxRpcItems: 1, maxToriiPages: 1, maxToriiItems: 100, pageSize: 20 },
      now: () => 15_000,
    } satisfies RepositoryContext;

    const response = await createActivityRepository(context).raw({ limit: 1 });

    expect(response.data.items[0]).toMatchObject({
      blockNumber: 0x123n,
      contract,
      transactionHash,
      timestamp: 1_784_016_000n,
    });
    expect(response.meta.warnings).toEqual([]);
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
      budget: { timeoutMs: 1, maxConcurrency: 1, maxRpcPages: 1, maxRpcItems: 1, maxToriiPages: 1, maxToriiItems: 100, pageSize: 1 },
      now: () => 15_000,
    } satisfies RepositoryContext;
    const response = await createFightEventsRepository(context, fights).list({ now: 15n });
    expect(response.data.items.map((event) => event.seasonId)).toEqual([1n, 2n]);
    expect(response.data.items).toHaveLength(2);
  });

  it("uses bounded singleton views when the aggregate fight feed is unavailable", async () => {
    const encodedFight = [
      ...encodeU256(1n), ...encodeU256(2n), ...encodeByteArray("Cage Night"), ...encodeU256(9n),
      ...encodeU256(11n), ...encodeByteArray("Fighter A"), ...encodeByteArray("Lightweight"),
      ...encodeU256(11n), ...encodeByteArray("A"), ...encodeU256(12n), ...encodeByteArray("Fighter B"),
      ...encodeByteArray("Lightweight"), ...encodeU256(12n), ...encodeByteArray("B"),
      "1700000000", "0", "0x0",
    ];
    const encodedMarket = [
      ...encodeU256(9n), "0x123", "1700000000", ...encodeU256(7n), ...encodeU256(8n),
      "0x456", "2", "0x789",
    ];
    const rpc = createMockRpcTransport({
      calls: {
        next_fight_id: encodeU256(2n),
        fight: encodedFight,
        get_market: encodedMarket,
        get_vault_numerator: encodeU256(1n),
        get_vault_denominator: encodeU256(2n),
        get_payout_numerator: encodeU256(0n),
        get_payout_denominator: encodeU256(0n),
        fight_winner_index: ["255"],
        winners_count: encodeU256(0n),
        fight_pot_total: encodeU256(0n),
        fight_pot_claimed: encodeU256(0n),
      },
    });
    const context = {
      network: MAINNET_PRESET,
      rpc,
      capabilities: { has: () => false, probe: async () => false, snapshot: () => MAINNET_PRESET.capabilities },
      budget: { timeoutMs: 1, maxConcurrency: 2, maxRpcPages: 1, maxRpcItems: 20, maxToriiPages: 1, maxToriiItems: 100, pageSize: 20 },
      now: () => 15_000,
    } satisfies RepositoryContext;

    const response = await createFightsRepository(context).feed({ limit: 1 });

    expect(response.data.items).toHaveLength(1);
    expect(response.data.items[0]?.fightId).toBe(1n);
    expect(response.meta.complete).toBe(false);
    expect(response.meta.warnings).toContainEqual(expect.objectContaining({ code: "AGGREGATE_VIEW_FALLBACK" }));
    expect(rpc.calls.some((call) => call.entrypoint === "get_fight_feed")).toBe(false);
  });

  it("paginates Torii fight buys with stable numeric cursors", async () => {
    const buy = (buyer: string, boughtAt: string) => ({
      fight_id: "1",
      buyer,
      market_id: "9",
      choice_index: "0",
      amount: "100",
      bought_at: boughtAt,
    });
    const toriiRequests: ToriiModelRequest[] = [];
    const torii = createMockToriiTransport({
      models: {
        FightBuy: {
          edges: [
            { cursor: "a", node: buy("0x1", "10") },
            { cursor: "b", node: buy("0x2", "20") },
            { cursor: "c", node: buy("0x3", "30") },
          ],
          totalCount: 3,
          pageInfo: { hasNextPage: false, endCursor: "c" },
        },
      },
    });
    const originalModel = torii.model.bind(torii);
    torii.model = async <T>(request: ToriiModelRequest, options?: RequestOptions) => {
      toriiRequests.push(request);
      return originalModel<T>(request, options);
    };
    const context = {
      network: MAINNET_PRESET,
      rpc: createMockRpcTransport(),
      torii,
      capabilities: { has: () => false, probe: async () => false, snapshot: () => MAINNET_PRESET.capabilities },
      budget: { timeoutMs: 1, maxConcurrency: 2, maxRpcPages: 1, maxRpcItems: 20, maxToriiPages: 1, maxToriiItems: 100, pageSize: 20 },
      now: () => 15_000,
    } satisfies RepositoryContext;

    const response = await createFightsRepository(context).buys(84n, { offset: 1, limit: 1 });

    expect(response.data.items.map((item) => item.buyer)).toEqual(["0x2"]);
    expect(response.data.cursor).toBe(2);
    expect(response.data.hasMore).toBe(true);
    expect(toriiRequests[0]?.where).toEqual({ fight_idEQ: "0x54" });
  });
});
