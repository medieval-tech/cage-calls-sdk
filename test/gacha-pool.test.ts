import { describe, expect, it } from "vitest";

import { createCageCallsClient, MAINNET_PRESET, type RpcTransport } from "../src/index.js";
import { encodeU256 } from "../src/core/codecs.js";
import { createMockRpcTransport } from "../src/testing/index.js";

const available = [51n, 46n, 47n, 16n, 18n, 6n, 1n];
const registered = [52n, 52n, 52n, 20n, 20n, 6n, 1n];
const expected = [52n, 52n, 52n, 20n, 20n, 6n, 1n];

const rarity = (call: { calldata?: readonly (string | number | bigint)[] }) =>
  Number(call.calldata?.[2] ?? -1);

function legacyPoolRpc() {
  return createMockRpcTransport({
    calls: {
      pool_open: ["1"],
      pool_size: encodeU256(185n),
      pool_available_count: (call) => encodeU256(available[rarity(call)] ?? 0n),
      pool_registered_count: (call) => encodeU256(registered[rarity(call)] ?? 0n),
      expected_count: (call) => encodeU256(expected[rarity(call)] ?? 0n),
    },
  });
}

describe("legacy Gacha pool hydration", () => {
  it("loads a complete seven-rarity snapshot through one RPC batch", async () => {
    const rpc = legacyPoolRpc();
    const client = createCageCallsClient({ network: MAINNET_PRESET, transports: { rpc }, resilience: false });

    const response = await client.gacha.pool(74n);

    expect(response.meta).toMatchObject({ source: "starknet-rpc", complete: true });
    expect(response.meta.warnings).toEqual([]);
    expect(response.data).toMatchObject({ fightId: 74n, open: true, size: 185n });
    expect(response.data.rarities).toEqual(available.map((value, rarityIndex) => ({
      rarity: rarityIndex,
      available: value,
      registered: registered[rarityIndex],
      expected: expected[rarityIndex],
    })));
    expect(rpc.batches).toHaveLength(1);
    expect(rpc.batches[0]).toHaveLength(23);
  });

  it("uses bounded singleton calls when a custom transport has no batch API", async () => {
    const mock = legacyPoolRpc();
    const rpc: RpcTransport = {
      request: mock.request,
      call: mock.call,
      getClassHashAt: mock.getClassHashAt,
    };
    const client = createCageCallsClient({ network: MAINNET_PRESET, transports: { rpc }, resilience: false });

    const response = await client.gacha.pool(74n);

    expect(response.meta.complete).toBe(true);
    expect(response.data.rarities).toHaveLength(7);
    expect(mock.batches).toEqual([]);
    expect(mock.calls).toHaveLength(23);
  });

  it("retains open and size without false rarity counters when a batch fails", async () => {
    const rpc = createMockRpcTransport({
      calls: {
        pool_open: ["1"],
        pool_size: encodeU256(185n),
        pool_available_count: new Error("batch unavailable"),
        pool_registered_count: encodeU256(1n),
        expected_count: encodeU256(1n),
      },
    });
    const client = createCageCallsClient({ network: MAINNET_PRESET, transports: { rpc }, resilience: false });

    const response = await client.gacha.pool(74n);

    expect(response.meta.complete).toBe(false);
    expect(response.meta.warnings.map((warning) => warning.code)).toContain("GACHA_POOL_DETAILS_UNAVAILABLE");
    expect(response.data).toMatchObject({ open: true, size: 185n, rarities: [] });
    expect(rpc.batches).toHaveLength(1);
    expect(rpc.calls.filter((call) => call.entrypoint === "pool_open")).toHaveLength(2);
    expect(rpc.calls.filter((call) => call.entrypoint === "pool_size")).toHaveLength(2);
  });

  it("propagates complete legacy state through a single-fight poolStates read", async () => {
    const rpc = legacyPoolRpc();
    const client = createCageCallsClient({ network: MAINNET_PRESET, transports: { rpc }, resilience: false });

    const response = await client.gacha.poolStates([74n]);

    expect(response.meta.complete).toBe(true);
    expect(response.data[0]?.rarities).toHaveLength(7);
  });
});
