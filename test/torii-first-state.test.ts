import { describe, expect, it } from "vitest";

import { MAINNET_PRESET, createCageCallsClient } from "../src/index.js";
import { createMockRpcTransport, createMockToriiTransport } from "../src/testing/index.js";

const connection = (nodes: Record<string, unknown>[]) => ({
  edges: nodes.map((node, index) => ({ cursor: `row-${index}`, node })),
  totalCount: nodes.length,
  pageInfo: { hasNextPage: false, ...(nodes.length ? { endCursor: `row-${nodes.length - 1}` } : {}) },
});

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

const market = {
  market_id: "900",
  creator: "0x1",
  created_at: "1700000000",
  question_id: "3",
  condition_id: "4",
  oracle: "0x5",
  outcome_slot_count: "2",
  collateral_token: MAINNET_PRESET.contracts.CALLS,
  start_at: "10",
  end_at: "1800000000",
  resolve_at: "1800000100",
  resolved_at: "1700001000",
};

describe("Torii-first account state", () => {
  it("composes positions and settled rewards from indexed models without RPC", async () => {
    const buyer = "0xabc";
    const rpc = createMockRpcTransport();
    const torii = createMockToriiTransport({
      models: {
        Fight: connection([fight]),
        Market: connection([market]),
        VaultNumerator: connection([
          { market_id: "900", index: "0", value: "45" },
          { market_id: "900", index: "1", value: "55" },
        ]),
        VaultDenominator: connection([{ market_id: "900", value: "100" }]),
        FightBuy: connection([{
          fight_id: "84",
          buyer,
          market_id: "900",
          choice_index: "1",
          amount: "1000000000000000000",
          bought_at: "1700000010",
        }]),
        FightWinner: connection([{ fight_id: "84", winner: buyer, choice_index: "1", redeemed: false }]),
        MarketBuy: connection([{
          market_id: "900",
          outcome_index: "1",
          account_address: MAINNET_PRESET.contracts.FightFactory,
          amount_in: "3000000000000000000",
        }]),
        PayoutNumerator: connection([
          { condition_id: "4", index: "0", value: "0" },
          { condition_id: "4", index: "1", value: "1" },
        ]),
        PayoutDenominator: connection([{ condition_id: "4", value: "1" }]),
      },
    });
    const client = createCageCallsClient({ network: "mainnet", transports: { rpc, torii } });

    const response = await client.accounts.fightStates(buyer);

    expect(response.meta).toMatchObject({ source: "derived", complete: true });
    expect(response.data.items).toHaveLength(1);
    expect(response.data.items[0]?.fight).toMatchObject({
      fightId: 84n,
      pot: { total: 3_000_000_000_000_000_000n, winnerIndex: 1, settled: true },
      viewer: {
        hasBought: true,
        choiceIndex: 1,
        isWinner: true,
        hasRedeemed: false,
        previewStrikeTickets: 3n,
      },
    });
    expect(response.data.actions).toEqual([{ type: "redeem-payout", fightId: 84n }]);
    expect(rpc.calls).toEqual([]);
    expect(rpc.requests).toEqual([]);
  });

  it("uses indexed ERC-1155 balances as the actual StrikeTicket inventory", async () => {
    const rpc = createMockRpcTransport();
    const torii = createMockToriiTransport({
      tokenBalances: {
        totalCount: 1,
        edges: [{
          node: {
            tokenMetadata: {
              __typename: "ERC1155__Token",
              contractAddress: MAINNET_PRESET.contracts.StrikeTickets,
              tokenId: "84",
              amount: "4",
            },
          },
        }],
      },
    });
    const client = createCageCallsClient({ network: "mainnet", transports: { rpc, torii } });

    const response = await client.tokens.strikeTicketBalances("0xabc");

    expect(response.meta).toMatchObject({ source: "torii", complete: true });
    expect(response.data).toEqual([{
      contractAddress: MAINNET_PRESET.contracts.StrikeTickets,
      tokenId: 84n,
      balance: 4n,
      tokenType: "erc1155",
    }]);
    expect(rpc.calls).toEqual([]);
  });
});
