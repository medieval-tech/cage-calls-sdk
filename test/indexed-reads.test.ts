import { describe, expect, it } from "vitest";

import { createCageCallsClient, encodeByteArray, encodeU256, SEPOLIA_DEV_PRESET } from "../src/index.js";
import { createMockRpcTransport, createMockToriiTransport } from "../src/testing.js";
import { encodeFightBuys, encodeFightFeed } from "./fixtures.js";

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
  it("chunks every fighter batch without truncating requested IDs", async () => {
    const fighterIds = Array.from({ length: 45 }, (_, index) => BigInt(index + 1));
    const rpc = createMockRpcTransport({
      calls: {
        get_fighters: (request) => {
          const calldata = request.calldata ?? [];
          const count = Number(calldata[0] ?? "0");
          const ids = Array.from({ length: count }, (_, index) => BigInt(calldata[1 + index * 2] ?? "0"));
          return [
            count.toString(),
            ...ids.flatMap((fighterId) => [
              ...encodeU256(fighterId),
              ...encodeByteArray(`Fighter ${fighterId}`),
              ...encodeByteArray("Lightweight"),
              "1",
            ]),
          ];
        },
      },
    });
    const client = createCageCallsClient({ network: SEPOLIA_DEV_PRESET, transports: { rpc } });

    const response = await client.fighters.getMany(fighterIds);

    expect(response.meta.complete).toBe(true);
    expect(response.data.map((fighter) => fighter.fighterId)).toEqual(fighterIds);
    expect(rpc.calls.filter((call) => call.entrypoint === "get_fighters")).toHaveLength(3);
  });

  it("enumerates role models beyond the former one-page limit", async () => {
    const roleRows = Array.from({ length: 101 }, (_, index) => ({
      cursor: `role-${index + 1}`,
      node: { admin: `0x${(index + 1).toString(16)}`, active: true },
    }));
    const torii = createMockToriiTransport({
      models: {
        FightFactoryAdmin: (request) => {
          const secondPage = request.after === "role-100";
          const edges = secondPage ? roleRows.slice(100) : roleRows.slice(0, 100);
          return {
            edges,
            totalCount: roleRows.length,
            pageInfo: {
              hasNextPage: !secondPage,
              endCursor: edges.at(-1)?.cursor ?? "",
            },
          };
        },
      },
    });
    const client = createCageCallsClient({ network: "mainnet", transports: { rpc: createMockRpcTransport(), torii } });

    const response = await client.admin.roles();

    expect(response.meta.complete).toBe(true);
    expect(response.data).toHaveLength(101);
    expect(response.data.at(-1)?.account).toBe("0x65");
  });

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

  it("reconstructs a complete analytics snapshot through upgraded RPC views when Torii is unavailable", async () => {
    const buyer = "0xabc";
    const rpc = createMockRpcTransport({
      calls: {
        get_fight_feed: encodeFightFeed([{ fightId: 84n, marketId: 900n, settled: true, winnerIndex: 1 }]),
        fight_buy_count: ["1"],
        get_fight_buys: encodeFightBuys([{
          fightId: 84n,
          buyer,
          marketId: 900n,
          choiceIndex: 1,
          amount: 100n,
          boughtAt: 1_700_000_010n,
        }]),
      },
    });
    const client = createCageCallsClient({ network: SEPOLIA_DEV_PRESET, transports: { rpc } });

    const response = await client.analytics.snapshot();

    expect(response.meta).toMatchObject({ source: "starknet-rpc", complete: true });
    expect(response.data.fights.map((item) => item.fightId)).toEqual([84n]);
    expect(response.data.buys).toEqual([expect.objectContaining({ fightId: 84n, buyer, amount: 100n })]);
    expect(response.data.winnerChoiceByFight).toEqual({ "84": 1 });
    expect(rpc.calls.map((call) => call.entrypoint)).toEqual(["get_fight_feed", "fight_buy_count", "get_fight_buys"]);
  });

  it("uses the aggregate fight feed for exhaustive fight fallback", async () => {
    const rpc = createMockRpcTransport({
      calls: {
        get_fight_feed: encodeFightFeed([
          { fightId: 84n, marketId: 900n },
          { fightId: 85n, marketId: 901n },
        ]),
      },
    });
    const client = createCageCallsClient({ network: SEPOLIA_DEV_PRESET, transports: { rpc } });

    const response = await client.fights.all();

    expect(response.meta).toMatchObject({ source: "starknet-rpc", complete: true });
    expect(response.data.map((item) => item.fightId)).toEqual([84n, 85n]);
    expect(rpc.calls.map((call) => call.entrypoint)).toEqual(["get_fight_feed"]);
  });

  it("reuses an indexed fight buy group once its RPC count is verified", async () => {
    const rpc = createMockRpcTransport({ calls: { fight_buy_count: ["1"] } });
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
          totalCount: 2,
          pageInfo: { hasNextPage: true, endCursor: "buy" },
        },
        FightWinner: {
          edges: [{ cursor: "winner", node: { fight_id: "84", winner: "0xabc", choice_index: "1", redeemed: false } }],
          totalCount: 1,
          pageInfo: { hasNextPage: false, endCursor: "winner" },
        },
      },
    });
    const client = createCageCallsClient({ network: SEPOLIA_DEV_PRESET, transports: { rpc, torii } });

    const response = await client.analytics.snapshot({ traversal: { maxToriiPages: 1 } });

    expect(response.meta).toMatchObject({ source: "starknet-rpc", complete: true });
    expect(response.data.buys).toHaveLength(1);
    expect(rpc.calls.map((call) => call.entrypoint)).toEqual(["fight_buy_count"]);
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
