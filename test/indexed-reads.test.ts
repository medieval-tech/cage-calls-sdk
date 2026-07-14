import { describe, expect, it } from "vitest";

import { createCageCallsClient } from "../src/index.js";
import { createMockRpcTransport, createMockToriiTransport } from "../src/testing.js";

const fight = {
  fight_id: "84",
  season_id: "1",
  event: "Cage Night",
  market_id: "900",
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
};

describe("Torii-first indexed reads", () => {
  it("builds an analytics snapshot without making RPC calls", async () => {
    const rpc = createMockRpcTransport();
    const torii = createMockToriiTransport({
      models: {
        Fight: {
          edges: [{ cursor: "fight", node: fight }],
          totalCount: 1,
          pageInfo: { hasNextPage: false, endCursor: "fight" },
        },
        FightBuy: {
          edges: [{ cursor: "buy", node: {
            fight_id: "84", buyer: "0xabc", market_id: "900", choice_index: "1", amount: "100", bought_at: "1700000010",
          } }],
          totalCount: 1,
          pageInfo: { hasNextPage: false, endCursor: "buy" },
        },
        FightWinner: {
          edges: [{ cursor: "winner", node: { fight_id: "84", winner: "0xabc", choice_index: "1", redeemed: false } }],
          totalCount: 1,
          pageInfo: { hasNextPage: false, endCursor: "winner" },
        },
      },
    });
    const client = createCageCallsClient({ network: "mainnet", transports: { rpc, torii } });

    const response = await client.analytics.snapshot();

    expect(response.meta).toMatchObject({ source: "torii", complete: true });
    expect(response.data.fights[0]?.fightId).toBe(84n);
    expect(response.data.buys[0]?.buyer).toBe("0xabc");
    expect(response.data.winnerChoiceByFight).toEqual({ "84": 1 });
    expect(rpc.calls).toEqual([]);
    expect(rpc.requests).toEqual([]);
  });

  it("joins market, fight, and vault models without making RPC calls", async () => {
    const rpc = createMockRpcTransport();
    const torii = createMockToriiTransport({
      models: {
        Market: {
          edges: [{ cursor: "market", node: {
            market_id: "900", creator: "0x1", created_at: "1700000000", question_id: "3", condition_id: "4",
            oracle: "0x5", outcome_slot_count: "2", collateral_token: "0x6", start_at: "10", end_at: "20",
            resolve_at: "30", resolved_at: "0",
          } }],
          totalCount: 1,
          pageInfo: { hasNextPage: false, endCursor: "market" },
        },
        Fight: {
          edges: [{ cursor: "fight", node: fight }],
          totalCount: 1,
          pageInfo: { hasNextPage: false, endCursor: "fight" },
        },
        VaultNumerator: {
          edges: [
            { cursor: "n0", node: { market_id: "900", index: "0", value: "30" } },
            { cursor: "n1", node: { market_id: "900", index: "1", value: "70" } },
          ],
          totalCount: 2,
          pageInfo: { hasNextPage: false, endCursor: "n1" },
        },
        VaultDenominator: {
          edges: [{ cursor: "denominator", node: { market_id: "900", value: "100" } }],
          totalCount: 1,
          pageInfo: { hasNextPage: false, endCursor: "denominator" },
        },
      },
    });
    const client = createCageCallsClient({ network: "mainnet", transports: { rpc, torii } });

    const response = await client.markets.catalog({ limit: 20 });

    expect(response.meta).toMatchObject({ source: "torii", complete: true });
    expect(response.data.items[0]).toMatchObject({
      fight: { fightId: 84n },
      vaultNumerators: [30n, 70n],
      vaultDenominator: 100n,
    });
    expect(rpc.calls).toEqual([]);
    expect(rpc.requests).toEqual([]);
  });
});
