import { describe, expect, it } from "vitest";

import {
  MAINNET_PRESET,
  SEPOLIA_DEV_PRESET,
  cageCallsQueryKeys,
  createCageCallsClient,
  decodeFightFeedRpc,
  deriveFightActionEligibility,
  deriveGachaActionEligibility,
  scopeCageCallsQueryKey,
  type FightFeedItem,
} from "../src/index.js";
import { createMockRpcTransport } from "../src/testing/index.js";
import { encodeFightBuys, encodeFightFeed } from "./fixtures.js";

const fight = (overrides: Partial<FightFeedItem> = {}): FightFeedItem => ({
  fightId: 1n, seasonId: 1n, eventName: "Cage Night", marketId: 2n,
  fighterAId: 10n, fighterAName: "A", fighterAWeightClass: "Lightweight", choiceAValue: 10n, choiceALabel: "A",
  fighterBId: 11n, fighterBName: "B", fighterBWeightClass: "Lightweight", choiceBValue: 11n, choiceBLabel: "B",
  createdAt: 1n, isDev: false, sponsor: "0x0", marketCreatedAt: 1n, conditionId: 3n, oracle: "0x4",
  outcomeSlotCount: 3, collateralToken: "0x5", startAt: 100n, endAt: 200n, resolveAt: 300n, resolvedAt: 0n,
  vaultNumerators: [1n, 1n, 1n], vaultDenominator: 3n, outcomeCounts: [], outcomeShares: [], payoutNumerators: [], payoutDenominator: 0n,
  pot: { total: 3n, claimed: 0n, winnersCount: 0n, closed: false, settled: false },
  viewer: { hasBought: false, shares: 0n, boughtAt: 0n, hasRedeemed: false, isWinner: false, previewStrikeTickets: 0n, strikeTickets: 0n },
  ...overrides,
});

describe("canonical viewer state", () => {
  it("neutralizes contradictory aggregate viewer payloads when hasBought is false", () => {
    const [decoded] = decodeFightFeedRpc(encodeFightFeed([{
      fightId: 1n,
      marketId: 2n,
      viewer: { hasBought: false, choiceIndex: 1, shares: 99n, boughtAt: 88n, hasRedeemed: true, isWinner: true, previewStrikeTickets: 7n },
    }]));
    expect(decoded?.viewer).toEqual({
      hasBought: false,
      shares: 0n,
      boughtAt: 0n,
      hasRedeemed: false,
      isWinner: false,
      previewStrikeTickets: 0n,
      strikeTickets: 0n,
    });
  });

  it("applies the same invariant to direct viewer reads", async () => {
    const rpc = createMockRpcTransport({ calls: {
      has_bought: ["0"],
      user_choice: ["1"],
      has_redeemed: ["1"],
      preview_strike_tickets: ["7", "0"],
      get_fight_buy: encodeFightBuys([{ fightId: 1n, buyer: "0xabc", marketId: 2n, choiceIndex: 1, amount: 99n, boughtAt: 88n }]).slice(1),
    } });
    const client = createCageCallsClient({ network: "mainnet", transports: { rpc } });
    await expect(client.fights.viewerState(1n, "0xabc")).resolves.toMatchObject({
      data: { hasBought: false, shares: 0n, boughtAt: 0n, hasRedeemed: false, isWinner: false, previewStrikeTickets: 0n, strikeTickets: 0n },
    });
  });
});

describe("fight action eligibility", () => {
  it("covers the buy lifecycle and existing positions", () => {
    expect(deriveFightActionEligibility({ fight: fight(), connected: true, now: 99n }).buy).toMatchObject({ allowed: false });
    expect(deriveFightActionEligibility({ fight: fight(), connected: true, now: 150n }).buy).toEqual({ allowed: true });
    expect(deriveFightActionEligibility({ fight: fight({ viewer: { hasBought: true, choiceIndex: 0, shares: 1n, boughtAt: 120n, hasRedeemed: false, isWinner: false, strikeTickets: 0n } }), connected: true, now: 150n }).buy.reason).toMatch(/already bid/i);
    expect(deriveFightActionEligibility({ fight: fight(), connected: true, now: 200n }).buy.reason).toMatch(/ended/i);
  });

  it("only allows verified redemption and admin transitions", () => {
    const settled = fight({
      resolvedAt: 301n,
      pot: { total: 3n, claimed: 0n, winnerIndex: 0, winnersCount: 1n, closed: true, settled: true },
      viewer: { hasBought: true, choiceIndex: 0, shares: 1n, boughtAt: 120n, hasRedeemed: false, isWinner: true, strikeTickets: 1n },
    });
    expect(deriveFightActionEligibility({ fight: settled, connected: true, stateComplete: true }).redeem.allowed).toBe(true);
    expect(deriveFightActionEligibility({ fight: settled, connected: true, stateComplete: false }).redeem.reason).toMatch(/verified/i);
    expect(deriveFightActionEligibility({ fight: fight(), fightFactoryAdmin: true }).close.allowed).toBe(true);
    expect(deriveFightActionEligibility({ fight: fight(), oracleAdmin: true, oracleWinnerSet: true, now: 300n }).settle.allowed).toBe(true);
    expect(deriveFightActionEligibility({ fight: fight(), oracleAdmin: true, oracleWinnerSet: false, now: 300n }).settle.reason).toMatch(/winner/i);
  });
});

describe("gacha action eligibility", () => {
  const readyPool = { fightId: 1n, open: false, size: 2n, rarities: [{ rarity: 0, expected: 2n, registered: 2n, available: 2n }] };
  const user = { fightId: 1n, user: "0xabc" as const, strikeNonce: 0n, ticketBalance: 1n };

  it("distinguishes closed, open, empty, and incomplete pools", () => {
    expect(deriveGachaActionEligibility({ pool: readyPool, gachaAdmin: true }).openPool.allowed).toBe(true);
    expect(deriveGachaActionEligibility({ pool: { ...readyPool, open: true }, gachaAdmin: true }).openPool.reason).toMatch(/already open/i);
    expect(deriveGachaActionEligibility({ pool: { ...readyPool, size: 0n }, gachaAdmin: true }).openPool.reason).toMatch(/empty/i);
    expect(deriveGachaActionEligibility({ pool: { ...readyPool, size: 1n, rarities: [{ rarity: 0, expected: 2n, registered: 1n, available: 1n }] }, gachaAdmin: true }).openPool.reason).toMatch(/incomplete/i);
    expect(deriveGachaActionEligibility({ pool: { ...readyPool, open: true }, gachaAdmin: true }).closePool.allowed).toBe(true);
  });

  it("uses actual ticket balances for public actions", () => {
    expect(deriveGachaActionEligibility({ pool: { ...readyPool, open: true }, user, connected: true }).strike.allowed).toBe(true);
    expect(deriveGachaActionEligibility({ pool: { ...readyPool, open: true }, user: { ...user, ticketBalance: 0n }, connected: true }).strike.reason).toMatch(/no StrikeTickets/i);
    expect(deriveGachaActionEligibility({ pool: { ...readyPool, open: true }, user: { ...user, ticketBalance: 0n, escrowedTokenId: 9n }, connected: true }).keep.allowed).toBe(true);
  });
});

describe("admin capabilities and query scope", () => {
  it("aggregates authoritative role checks and caches by account", async () => {
    const rpc = createMockRpcTransport({ calls: {
      is_admin: (call) => [call.contractAddress === MAINNET_PRESET.contracts.Gacha ? "1" : "0"],
      has_role: (call) => [call.contractAddress === MAINNET_PRESET.contracts.RelicNFT ? "1" : "0"],
    } });
    const client = createCageCallsClient({ network: "mainnet", transports: { rpc }, now: () => 1_000 });
    const first = await client.admin.capabilities("0xabc");
    const second = await client.admin.capabilities("0xabc");
    expect(first.data).toMatchObject({ gacha: true, relicMinter: true, relicAdmin: true, fightFactory: false, isAnyAdmin: true });
    expect(second).toBe(first);
    expect(rpc.calls).toHaveLength(8);
  });

  it("scopes otherwise identical keys by deployment", () => {
    const base = cageCallsQueryKeys.tokens("0xabc", "calls-balance");
    const mainnet = scopeCageCallsQueryKey(MAINNET_PRESET, base);
    const sepolia = scopeCageCallsQueryKey(SEPOLIA_DEV_PRESET, base);
    expect(mainnet).not.toEqual(sepolia);
    expect(mainnet).toContain("0xabc");
  });
});
