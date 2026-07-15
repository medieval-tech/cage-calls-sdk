import { describe, expect, it } from "vitest";

import {
  MAINNET_PRESET,
  createAggregateRepositories,
  type DataResult,
  type FightFeedItem,
  type FightsRepository,
  type GachaRepository,
  type OwnedRelicsPage,
  type RelicsRepository,
  type RepositoryContext,
  type TokensRepository,
} from "../src/index.js";
import { createMockRpcTransport } from "../src/testing.js";

const result = <T,>(data: T): DataResult<T> => ({
  data,
  meta: { source: "derived", complete: true, attempts: [], warnings: [], fetchedAt: 0, durationMs: 0 },
});

function feedFight(fightId: bigint, viewer: FightFeedItem["viewer"]): FightFeedItem {
  return {
    fightId, seasonId: 7n, eventName: "Cage Night", marketId: fightId,
    fighterAId: 1n, fighterAName: "A", fighterAWeightClass: "Lightweight", choiceAValue: 1n, choiceALabel: "A",
    fighterBId: 2n, fighterBName: "B", fighterBWeightClass: "Lightweight", choiceBValue: 2n, choiceBLabel: "B",
    createdAt: 1n, isDev: false, sponsor: "0x0", marketCreatedAt: 1n, conditionId: fightId, oracle: "0x1",
    outcomeSlotCount: 2, collateralToken: "0x2", startAt: 1n, endAt: 2n, resolveAt: 3n, resolvedAt: 0n,
    vaultNumerators: [1n, 1n], vaultDenominator: 2n, outcomeCounts: [], outcomeShares: [], payoutNumerators: [], payoutDenominator: 0n,
    pot: { total: 10n, claimed: 0n, winnerIndex: 0, winnersCount: 1n, closed: true, settled: true }, viewer,
  };
}

describe("public and account aggregates", () => {
  const context = {
    network: MAINNET_PRESET,
    rpc: createMockRpcTransport(),
    capabilities: { has: () => true, probe: async () => true, snapshot: () => MAINNET_PRESET.capabilities },
    budget: { timeoutMs: 1, maxConcurrency: 4, maxRpcPages: 10, maxRpcItems: 100, maxToriiPages: 10, maxToriiItems: 100, pageSize: 20, relicBatchSize: 100 },
    now: () => 10_000,
  } satisfies RepositoryContext;

  it("keeps a public snapshot independent from account state", async () => {
    const viewers: Array<string | undefined> = [];
    const fights = {
      feedAll: async (input?: { viewer?: string }) => {
        viewers.push(input?.viewer);
        return result([feedFight(1n, { hasBought: false, shares: 0n, boughtAt: 0n, hasRedeemed: false, isWinner: false, strikeTickets: 0n })]);
      },
    } as unknown as FightsRepository;
    const gacha = { pool: async (fightId: bigint) => result({ fightId, open: true, size: 1n, rarities: [] }) } as unknown as GachaRepository;
    const relics = {} as RelicsRepository;
    const tokens = {} as TokensRepository;
    const repositories = createAggregateRepositories(context, { fights, gacha, relics, tokens });
    const snapshot = await repositories.events.get({ seasonId: 7n, eventName: "Cage Night" });
    expect(snapshot.data.fights).toHaveLength(1);
    expect(viewers).toEqual([undefined]);
  });

  it("returns every currently actionable portfolio operation", async () => {
    const winner = feedFight(1n, { hasBought: true, choiceIndex: 0, shares: 10n, boughtAt: 1n, hasRedeemed: false, isWinner: true, strikeTickets: 1n });
    const striker = feedFight(2n, { hasBought: true, choiceIndex: 1, shares: 10n, boughtAt: 1n, hasRedeemed: true, isWinner: false, strikeTickets: 1n });
    const fights = {
      feedAll: async () => result([winner, striker]),
      portfolioAll: async () => result([]),
    } as unknown as FightsRepository;
    const gacha = {
      pool: async (fightId: bigint) => result({ fightId, open: true, size: 1n, rarities: [] }),
      user: async (fightId: bigint) => result({ fightId, user: "0xabc", ...(fightId === 1n ? { escrowedTokenId: 99n } : {}), strikeNonce: 0n, ticketBalance: 1n }),
    } as unknown as GachaRepository;
    const owned: OwnedRelicsPage = { items: [], hasMore: false, provenance: { owner: "0xabc", onchainBalance: 0n, ownershipSource: "starknet-rpc", verified: true } };
    const relics = { owned: async () => result(owned) } as unknown as RelicsRepository;
    const tokens = { callsBalance: async () => result(123n) } as unknown as TokensRepository;
    const repositories = createAggregateRepositories(context, { fights, gacha, relics, tokens });
    const portfolio = await repositories.accounts.portfolio("0xabc");
    expect(portfolio.data.callsBalance).toBe(123n);
    expect(portfolio.data.actions).toEqual([
      { type: "redeem-payout", fightId: 1n },
      { type: "keep-relic", fightId: 1n, tokenId: 99n },
      { type: "strike-gacha", fightId: 2n, ticketBalance: 1n },
    ]);
  });
});
