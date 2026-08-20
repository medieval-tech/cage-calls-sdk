import { describe, expect, it } from "vitest";

import { MAINNET_PRESET, createCageCallsClient } from "../src/index.js";
import { createMockRpcTransport, createMockToriiTransport } from "../src/testing/index.js";

const connection = (nodes: Record<string, unknown>[]) => ({
  edges: nodes.map((node, index) => ({ cursor: `row-${index}`, node })),
  totalCount: nodes.length,
  pageInfo: { hasNextPage: false, ...(nodes.length ? { endCursor: `row-${nodes.length - 1}` } : {}) },
});

const fightRow = (fightId: string, marketId: string) => ({
  fight_id: fightId,
  season_id: "1",
  event: "main-card",
  market_id: marketId,
  fighter_a_id: "1",
  fighter_a_name: "A",
  fighter_a_weight_class: "Lightweight",
  choice_a_value: "1",
  choice_a_label: "A",
  fighter_b_id: "2",
  fighter_b_name: "B",
  fighter_b_weight_class: "Lightweight",
  choice_b_value: "2",
  choice_b_label: "B",
  created_at: "1700000000",
  is_dev: false,
  sponsor: "0",
});

const marketRow = (marketId: string, conditionId: string) => ({
  market_id: marketId,
  creator: "0x1",
  created_at: "1700000000",
  question_id: "3",
  condition_id: conditionId,
  oracle: "0x5",
  outcome_slot_count: "2",
  collateral_token: MAINNET_PRESET.contracts.CALLS,
  start_at: "10",
  end_at: "1600000000",
  resolve_at: "1600000100",
  resolved_at: "1700001000",
});

const buyRow = (fightId: string, buyer: string, marketId: string, choice: string, amount: string) => ({
  fight_id: fightId,
  buyer,
  market_id: marketId,
  choice_index: choice,
  amount,
  bought_at: "1700000010",
});

describe("accounts.portfolio viewer-scoped hydration", () => {
  it("pushes viewer/factory filters to torii and never fetches cross-account rows", async () => {
    const buyer = "0xabc";
    const other = "0xdef";
    const ONE = "1000000000000000000";
    const THREE = "3000000000000000000";
    const fightBuyWheres: Array<Record<string, unknown>> = [];
    const fightWinnerWheres: Array<Record<string, unknown>> = [];
    const marketBuyWheres: Array<Record<string, unknown>> = [];

    const rpc = createMockRpcTransport();
    const torii = createMockToriiTransport({
      models: {
        // Bought 84 (won: choice 1) and 85 (lost: chose 0, winner 1).
        Fight: connection([fightRow("84", "900"), fightRow("85", "901")]),
        Market: connection([marketRow("900", "4"), marketRow("901", "5")]),
        VaultNumerator: connection([
          { market_id: "900", index: "0", value: "45" },
          { market_id: "900", index: "1", value: "55" },
          { market_id: "901", index: "0", value: "45" },
          { market_id: "901", index: "1", value: "55" },
        ]),
        VaultDenominator: connection([
          { market_id: "900", value: "100" },
          { market_id: "901", value: "100" },
        ]),
        FightBuy: (request) => {
          const where = (request.where ?? {}) as Record<string, unknown>;
          fightBuyWheres.push(where);
          // portfolioAll's buyer enumeration + the viewer-scoped snapshot read
          if (where.buyerEQ) return connection([
            buyRow("84", buyer, "900", "1", ONE),
            buyRow("85", buyer, "901", "0", ONE),
          ]);
          // enrichment: full rows for the won fight only
          return connection([
            buyRow("84", buyer, "900", "1", ONE),
            buyRow("84", other, "900", "1", THREE),
          ]);
        },
        FightWinner: (request) => {
          const where = (request.where ?? {}) as Record<string, unknown>;
          fightWinnerWheres.push(where);
          if (where.winnerEQ) return connection([{ fight_id: "84", winner: buyer, choice_index: "1", redeemed: false }]);
          return connection([
            { fight_id: "84", winner: buyer, choice_index: "1", redeemed: false },
            { fight_id: "84", winner: other, choice_index: "1", redeemed: true },
          ]);
        },
        MarketBuy: (request) => {
          const where = (request.where ?? {}) as Record<string, unknown>;
          marketBuyWheres.push(where);
          return connection([
            { market_id: "900", outcome_index: "1", account_address: MAINNET_PRESET.contracts.FightFactory, amount_in: "4000000000000000000" },
            { market_id: "901", outcome_index: "1", account_address: MAINNET_PRESET.contracts.FightFactory, amount_in: "2000000000000000000" },
          ]);
        },
        PayoutNumerator: connection([
          { condition_id: "4", index: "0", value: "0" },
          { condition_id: "4", index: "1", value: "1" },
          { condition_id: "5", index: "0", value: "0" },
          { condition_id: "5", index: "1", value: "1" },
        ]),
        PayoutDenominator: connection([
          { condition_id: "4", value: "1" },
          { condition_id: "5", value: "1" },
        ]),
      },
    });
    const client = createCageCallsClient({ network: "mainnet", transports: { rpc, torii } });

    const response = await client.accounts.portfolio(buyer);

    // Every heavy read carried the scoping filters — no cross-account fetches,
    // and MarketBuy (a ~full-table read on these markets) is never queried.
    expect(fightBuyWheres.length).toBeGreaterThan(0);
    expect(fightBuyWheres.every((where) => where.buyerEQ)).toBe(true);
    expect(fightWinnerWheres.every((where) => where.winnerEQ)).toBe(true);
    expect(marketBuyWheres).toEqual([]);

    const won = response.data.fights.find((entry) => entry.fight.fightId === 84n)?.fight;
    const lost = response.data.fights.find((entry) => entry.fight.fightId === 85n)?.fight;
    // Actionable state is exact: winnerIndex/settled (payouts) and the
    // viewer's own win/redeem state. Cross-account aggregates (pot.total,
    // claimed, winnersCount, preview tickets) are zeroed, never computed from
    // partial rows.
    expect(won?.pot).toMatchObject({ total: 0n, claimed: 0n, winnersCount: 0n, winnerIndex: 1, settled: true });
    expect(won?.viewer).toMatchObject({ hasBought: true, isWinner: true, hasRedeemed: false, previewStrikeTickets: 0n });
    expect(won?.oddsSeries).toBeUndefined();
    expect(lost?.pot).toMatchObject({ total: 0n, settled: true });
    expect(lost?.viewer).toMatchObject({ hasBought: true, choiceIndex: 0, isWinner: false });

    expect(response.meta.complete).toBe(true);
    // The one-time cached locked_odds_cutover config read is the only RPC allowed.
    expect(rpc.calls.filter((call) => call.entrypoint !== "locked_odds_cutover")).toEqual([]);
  });
});
