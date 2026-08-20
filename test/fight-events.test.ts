import { describe, expect, it, vi } from "vitest";

import { MAINNET_PRESET } from "../src/index.js";
import { createMockRpcTransport, createMockToriiTransport, createTestClient } from "../src/testing/index.js";
import { encodeFightFeed } from "./fixtures.js";

const connection = (nodes: Record<string, unknown>[]) => ({
  edges: nodes.map((node, index) => ({ cursor: `row-${index}`, node })),
  totalCount: nodes.length,
  pageInfo: { hasNextPage: false, ...(nodes.length ? { endCursor: `row-${nodes.length - 1}` } : {}) },
});

const fightRow = (fightId: string, eventName: string, marketId: string) => ({
  fight_id: fightId,
  season_id: "1",
  event: eventName,
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
  end_at: "1800000000",
  resolve_at: "1800000100",
  resolved_at: "0",
});

describe("fightEvents.get", () => {
  it("resolves an event from one slim index scan plus matched snapshots, never the cursor walk", async () => {
    const fights = [
      fightRow("106", "main-card", "206"),
      fightRow("105", "main-card", "205"),
      fightRow("60", "old-event", "160"),
    ];
    let fightQueries = 0;
    const rpc = createMockRpcTransport();
    const torii = createMockToriiTransport({
      models: {
        Fight: (request) => {
          fightQueries += 1;
          const wanted = (request.where as Record<string, unknown> | undefined)?.fight_idIN as string[] | undefined;
          if (wanted) {
            const ids = new Set(wanted.map((value) => BigInt(value).toString()));
            return connection(fights.filter((row) => ids.has(BigInt(row.fight_id).toString())));
          }
          return connection(fights);
        },
        Market: connection([marketRow("206", "4"), marketRow("205", "5")]),
      },
    });
    const client = createTestClient({ network: MAINNET_PRESET, transports: { rpc, torii } });

    const response = await client.fightEvents.get("main-card");

    expect(response.data?.fights.map((fight) => fight.fightId)).toEqual([106n, 105n]);
    expect(response.meta.source).toBe("torii");
    expect(response.meta.complete).toBe(true);
    expect(response.meta.warnings).toEqual([]);
    // The one-time cached locked_odds_cutover config read is the only RPC allowed.
    expect(rpc.calls.filter((call) => call.entrypoint !== "locked_odds_cutover")).toEqual([]);
    // Index scan + matched-id hydration only; a cursor walk would add one
    // Fight query per feed page.
    expect(fightQueries).toBe(2);
  });

  it("returns an empty event as complete when the index scan finds no matching fights", async () => {
    const rpc = createMockRpcTransport();
    const torii = createMockToriiTransport({
      models: { Fight: connection([fightRow("60", "old-event", "160")]) },
    });
    const client = createTestClient({ network: MAINNET_PRESET, transports: { rpc, torii } });

    const response = await client.fightEvents.get("unknown-event");

    expect(response.data).toBeUndefined();
    expect(response.meta.complete).toBe(true);
    // The one-time cached locked_odds_cutover config read is the only RPC allowed.
    expect(rpc.calls.filter((call) => call.entrypoint !== "locked_odds_cutover")).toEqual([]);
  });

  it("falls back to the cursor walk with a logged warning when the index scan fails", async () => {
    const rpc = createMockRpcTransport({
      calls: {
        get_fight_feed: encodeFightFeed([
          { fightId: 2n, marketId: 102n },
          { fightId: 1n, marketId: 101n },
        ]),
      },
    });
    const torii = createMockToriiTransport({
      models: { Fight: new Error("torii offline") },
    });
    const warn = vi.fn();
    const client = createTestClient({
      network: MAINNET_PRESET,
      transports: { rpc, torii },
      logger: { debug: () => {}, info: () => {}, warn, error: () => {} },
    });

    const response = await client.fightEvents.get("Cage Night");

    expect(response.data?.fights.map((fight) => fight.fightId)).toEqual([2n, 1n]);
    expect(response.meta.source).toBe("starknet-rpc");
    expect(response.meta.warnings.some((warning) => warning.code === "TORII_FALLBACK")).toBe(true);
    expect(warn).toHaveBeenCalled();
  });
});
