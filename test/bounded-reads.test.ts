import { describe, expect, it } from "vitest";

import { MAINNET_PRESET, SEPOLIA_DEV_PRESET, type RpcCall } from "../src/index.js";
import { createMockRpcTransport, createTestClient } from "../src/testing/index.js";
import { encodeU256 } from "../src/core/codecs.js";
import { encodeFightFeed } from "./fixtures.js";

const idsFromSpan = (call: RpcCall): bigint[] => {
  const calldata = call.calldata ?? [];
  const count = Number(calldata[0] ?? 0);
  return Array.from({ length: count }, (_, index) => BigInt(calldata[1 + index * 2] ?? 0));
};

const encodePool = (fightId: bigint, open = true) => [
  ...encodeU256(fightId),
  open ? "1" : "0",
  ...encodeU256(1n),
  "0",
];

const encodeUserStates = (ids: readonly bigint[]) => [
  "7",
  ids.length.toString(),
  ...ids.flatMap((fightId) => [
    ...encodePool(fightId),
    ...encodeU256(fightId + 10n),
    ...encodeU256(0n),
  ]),
];

describe("bounded product reads", () => {
  it("deduplicates, chunks, and preserves caller order for exact fight feeds", async () => {
    const rpc = createMockRpcTransport({
      calls: {
        get_fight_feed_by_ids: (call) => {
          const ids = idsFromSpan(call);
          return encodeFightFeed(ids.map((fightId) => ({ fightId, marketId: fightId + 100n })));
        },
      },
    });
    const client = createTestClient({
      network: SEPOLIA_DEV_PRESET,
      rpc,
      capabilities: { fightFeedByIds: true },
    });
    const ids = [25n, ...Array.from({ length: 24 }, (_, index) => BigInt(index + 1)), 25n];

    const response = await client.fights.feedMany(ids);

    expect(response.meta.complete).toBe(true);
    expect(response.data.map((fight) => fight.fightId)).toEqual(ids.slice(0, -1));
    expect(rpc.calls.filter((call) => call.entrypoint === "get_fight_feed_by_ids")).toHaveLength(2);
  });

  it("does not replace a missing aggregate with per-fight RPC fan-out", async () => {
    const rpc = createMockRpcTransport({
      calls: {
        get_fight_feed_by_ids: new Error("entrypoint missing"),
        get_fight_feed: (call) => {
          const fightId = BigInt(call.calldata?.[0] ?? 0);
          return encodeFightFeed([{ fightId, marketId: fightId + 100n }]);
        },
      },
    });
    const client = createTestClient({
      network: SEPOLIA_DEV_PRESET,
      rpc,
      capabilities: { fightFeedByIds: false },
    });

    await expect(client.fights.feedMany([9n, 3n])).rejects.toThrow("exact fight snapshots");
    expect(rpc.calls).toEqual([]);
  });

  it("retrieves an event by backend-known IDs without scanning the fight cursor", async () => {
    const rpc = createMockRpcTransport({
      calls: {
        get_fight_feed_by_ids: (call) => encodeFightFeed(idsFromSpan(call).map((fightId) => ({ fightId, marketId: fightId + 100n }))),
      },
    });
    const client = createTestClient({ network: SEPOLIA_DEV_PRESET, rpc, capabilities: { fightFeedByIds: true } });

    const response = await client.fightEvents.get("Cage Night", { seasonId: 1n, fightIds: [8n, 7n] });

    expect(response.data?.fights.map((fight) => fight.fightId)).toEqual([8n, 7n]);
    expect(rpc.calls.map((call) => call.entrypoint)).toEqual(["get_fight_feed_by_ids"]);
  });

  it("batches Gacha pools and account action state", async () => {
    const rpc = createMockRpcTransport({
      calls: {
        get_pool_states: (call) => {
          const ids = idsFromSpan(call);
          return [ids.length.toString(), ...ids.flatMap((fightId) => encodePool(fightId))];
        },
        get_account_fight_feed: encodeFightFeed([{ fightId: 4n, marketId: 104n }]),
        get_user_states: [
          "0",
          "1",
          ...encodePool(4n),
          ...encodeU256(2n),
          ...encodeU256(0n),
        ],
      },
    });
    const client = createTestClient({
      network: SEPOLIA_DEV_PRESET,
      rpc,
      capabilities: { accountFightFeed: true, gachaUserStates: true, gachaPoolAggregate: true },
    });

    const pools = await client.gacha.poolStates([4n, 2n]);
    const account = await client.accounts.fightStates("0xabc", { limit: 20 });

    expect(pools.data.map((pool) => pool.fightId)).toEqual([4n, 2n]);
    expect(account.data.items).toHaveLength(1);
    expect(account.data.actions).toEqual([]);
    expect(rpc.calls.filter((call) => call.entrypoint === "get_account_fight_feed")).toHaveLength(1);
    expect(rpc.calls.filter((call) => call.entrypoint === "get_user_states")).toHaveLength(0);
  });

  it("advances the inclusive account cursor without duplicating the oldest fight", async () => {
    const rpc = createMockRpcTransport({
      calls: {
        get_account_fight_feed: (call) => {
          const cursor = BigInt(call.calldata?.[1] ?? 0);
          return encodeFightFeed(cursor === 0n
            ? [{ fightId: 3n, marketId: 103n }, { fightId: 2n, marketId: 102n }]
            : [{ fightId: cursor, marketId: cursor + 100n }]);
        },
      },
    });
    const client = createTestClient({
      network: SEPOLIA_DEV_PRESET,
      rpc,
      capabilities: { accountFightFeed: true },
    });

    const first = await client.fights.accountFeed("0xabc", { limit: 2 });
    const second = await client.fights.accountFeed("0xabc", { limit: 2, cursor: first.data.cursor! });

    expect(first.data.cursor).toBe(1n);
    expect(first.data.hasMore).toBe(true);
    expect(second.data.items.map((fight) => fight.fightId)).toEqual([1n]);
    expect(rpc.calls.at(-1)?.calldata).toEqual(["0xabc", "1", "0", "2"]);
  });

  it("chunks Gacha account state instead of silently truncating after twenty fights", async () => {
    const rpc = createMockRpcTransport({
      calls: {
        get_user_states: (call) => encodeUserStates(idsFromSpan(call)),
      },
    });
    const client = createTestClient({
      network: SEPOLIA_DEV_PRESET,
      rpc,
      capabilities: { gachaUserStates: true },
    });
    const ids = [...Array.from({ length: 25 }, (_, index) => BigInt(index + 1)), 1n];

    const response = await client.gacha.userStates(ids, "0xabc");

    expect(response.meta.complete).toBe(true);
    expect(response.data.states.map((state) => state.fightId)).toEqual(ids.slice(0, -1));
    expect(rpc.calls.filter((call) => call.entrypoint === "get_user_states")).toHaveLength(2);
  });

  it("treats generated unsupported capabilities as authoritative", async () => {
    const rpc = createMockRpcTransport({ calls: { get_account_fight_feed: ["0"] } });
    const client = createTestClient({
      network: MAINNET_PRESET,
      rpc,
      capabilities: { fightFeedByIds: true },
    });

    expect(client.capabilities.diagnostics().fightFeedByIds).toEqual({ supported: true, source: "override" });
    await client.capabilities.probe("accountFightFeed");

    expect(rpc.calls).toEqual([]);
    expect(client.capabilities.diagnostics().accountFightFeed).toEqual({ supported: false, source: "preset" });
  });
});
