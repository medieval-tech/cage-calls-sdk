import { describe, expect, it, vi } from "vitest";

import { createCageCallsClient, MAINNET_PRESET, SEPOLIA_DEV_PRESET } from "../src/index.js";
import {
  createMockMetadataTransport,
  createMockRpcTransport,
  createMockToriiTransport,
} from "../src/testing.js";
import { encodeOwnedPage, encodeRelicRows, toriiToken } from "./fixtures.js";

const owner = "0x123" as const;

describe("relic ownership source policy", () => {
  it("uses the aggregate RPC fallback when Torii inventory is unexpectedly empty", async () => {
    const rpc = createMockRpcTransport({
      calls: { get_relic_feed: encodeRelicRows([{ tokenId: 2n, owner }, { tokenId: 1n, owner }]) },
    });
    const torii = createMockToriiTransport({ tokens: { totalCount: 0, edges: [] } });
    const upgraded = {
      ...SEPOLIA_DEV_PRESET,
      capabilities: { ...SEPOLIA_DEV_PRESET.capabilities, relicFeed: true },
    };
    const metadata = createMockMetadataTransport({
      "ipfs://metadata-1": { name: "One", image: "ipfs://one", attributes: [{ trait_type: "Power", value: 1 }] },
      "ipfs://metadata-2": { name: "Two", image: "ipfs://two", attributes: [{ trait_type: "Power", value: 2 }] },
    });
    const client = createCageCallsClient({ network: upgraded, transports: { rpc, torii, metadata } });

    const response = await client.relics.feed({ limit: 2 });

    expect(response.meta.source).toBe("starknet-rpc");
    expect(response.data.items.map((relic) => relic.tokenId)).toEqual([2n, 1n]);
    expect(response.meta.complete).toBe(true);
    expect(response.meta.warnings.map((warning) => warning.code)).toContain("TORII_INVENTORY_EMPTY");
  });

  it("hydrates external JSON for aggregate RPC fallback rows", async () => {
    const rpc = createMockRpcTransport({
      calls: { get_relic_feed: encodeRelicRows([{ tokenId: 1n, owner }]) },
    });
    const metadata = createMockMetadataTransport({
      "ipfs://metadata-1": { name: "External", image: "ipfs://image", attributes: [] },
    });
    const getJson = vi.spyOn(metadata, "getJson");
    const upgraded = {
      ...SEPOLIA_DEV_PRESET,
      capabilities: { ...SEPOLIA_DEV_PRESET.capabilities, relicFeed: true },
    };
    const client = createCageCallsClient({ network: upgraded, transports: { rpc, metadata } });

    const response = await client.relics.feed({ limit: 1 });

    expect(response.data.items[0]?.metadata?.fightId).toBe(10n);
    expect(response.data.items[0]?.name).toBe("External");
    expect(response.meta.complete).toBe(false);
    expect(getJson).toHaveBeenCalledTimes(1);
  });

  it("enumerates with Torii first and batch-enriches only incomplete rows", async () => {
    const rpc = createMockRpcTransport({
      calls: { get_relics: encodeRelicRows([{ tokenId: 1n, owner }]) },
    });
    const torii = createMockToriiTransport({
      tokens: {
        totalCount: 1,
        edges: [{ node: { tokenMetadata: toriiToken(1n, SEPOLIA_DEV_PRESET.contracts.RelicNFT, false) } }],
      },
    });
    const metadata = createMockMetadataTransport({
      "ipfs://metadata-1": { name: "Hydrated", image: "ipfs://image", attributes: [{ trait_type: "Power", value: 8 }] },
    });
    const upgraded = {
      ...SEPOLIA_DEV_PRESET,
      capabilities: { ...SEPOLIA_DEV_PRESET.capabilities, relicFeed: true, relicBatch: true },
    };
    const client = createCageCallsClient({ network: upgraded, transports: { rpc, torii, metadata } });

    const response = await client.relics.feed({ limit: 1 });

    expect(response.meta.source).toBe("torii");
    expect(response.data.items[0]?.metadata?.fightId).toBe(10n);
    expect(response.data.items[0]?.name).toBe("Hydrated");
    expect(rpc.calls.map((call) => call.entrypoint)).toEqual(["max_relic_batch_size", "get_relics"]);
  });

  it("continues an interrupted Torii feed through RPC without restarting or duplicating relics", async () => {
    const rpc = createMockRpcTransport({
      calls: {
        get_relic_feed: (request) => {
          const cursor = BigInt(request.calldata?.[0] ?? "0");
          return encodeRelicRows([{ tokenId: cursor, owner }]);
        },
      },
    });
    const baseTorii = createMockToriiTransport();
    const tokens = vi.fn(async (_contract, request?: { offset?: number }) => {
      if (request?.offset) throw new Error("Torii temporarily unavailable");
      return {
        data: {
          totalCount: 3,
          pageInfo: { hasNextPage: true, endCursor: "relic-3" },
          edges: [{ cursor: "relic-3", node: { tokenMetadata: toriiToken(3n, SEPOLIA_DEV_PRESET.contracts.RelicNFT) } }],
        },
        attempts: [],
      };
    });
    const torii = { ...baseTorii, tokens };
    const upgraded = {
      ...SEPOLIA_DEV_PRESET,
      capabilities: { ...SEPOLIA_DEV_PRESET.capabilities, relicFeed: true },
    };
    const client = createCageCallsClient({ network: upgraded, transports: { rpc, torii } });

    const first = await client.relics.feed({ limit: 1 });
    const second = await client.relics.feed({ limit: 1, cursor: first.data.cursor! });
    const third = await client.relics.feed({ limit: 1, cursor: second.data.cursor! });

    expect(first.data.items.map((relic) => relic.tokenId)).toEqual([3n]);
    expect(second.data.items.map((relic) => relic.tokenId)).toEqual([2n]);
    expect(third.data.items.map((relic) => relic.tokenId)).toEqual([1n]);
    expect(first.data.cursor).toBeLessThan(0n);
    expect(second.data.cursor).toBeLessThan(0n);
    expect(tokens).toHaveBeenCalledTimes(2);
    expect(rpc.calls.filter((call) => call.entrypoint === "get_relic_feed").map((call) => call.calldata?.[0])).toEqual(["2", "1"]);
    expect(second.meta.warnings.map((warning) => warning.code)).toContain("TORII_UNAVAILABLE");
  });

  it("trusts known-disabled preset capabilities without probing missing entrypoints", async () => {
    const rpc = createMockRpcTransport();
    const torii = createMockToriiTransport({
      tokens: {
        totalCount: 1,
        edges: [{ node: { tokenMetadata: toriiToken(1n, MAINNET_PRESET.contracts.RelicNFT) } }],
      },
    });
    const client = createCageCallsClient({ network: "mainnet", transports: { rpc, torii } });

    const response = await client.relics.feed({ limit: 1 });

    expect(response.data.items).toHaveLength(1);
    expect(rpc.calls).toEqual([]);
  });

  it("enumerates complete Torii collections beyond the former 1,000-row window without RPC", async () => {
    const totalRows = 1_205;
    const rpc = createMockRpcTransport({ calls: { next_token_id: [String(totalRows + 1), "0"] } });
    const torii = createMockToriiTransport({
      tokens: ({ offset = 0, limit = 100 }) => ({
        totalCount: totalRows + 1,
        edges: Array.from({ length: Math.min(limit, totalRows - offset) }, (_, index) => ({
          node: { tokenMetadata: toriiToken(BigInt(offset + index + 1), SEPOLIA_DEV_PRESET.contracts.RelicNFT) },
        })),
      }),
    });
    const client = createCageCallsClient({ network: SEPOLIA_DEV_PRESET, transports: { rpc, torii } });

    const response = await client.relics.collection({ pageSize: 200, enrichFighters: false });

    expect(response.data.items).toHaveLength(totalRows);
    expect(response.data.pageCount).toBe(7);
    expect(response.meta.complete).toBe(true);
    expect(rpc.calls.map((call) => call.entrypoint)).toEqual(["next_token_id"]);
  });

  it("hydrates exactly the incomplete Torii rows across a full collection", async () => {
    const totalRows = 1_205;
    const missingIds = new Set([1n, 201n, 401n, 601n, 1_205n]);
    const requestedIds: bigint[] = [];
    const rpc = createMockRpcTransport({
      calls: {
        get_relics: (request) => {
          const calldata = request.calldata ?? [];
          const count = Number(calldata[0] ?? "0");
          const ids = Array.from({ length: count }, (_, index) => BigInt(calldata[1 + index * 2] ?? "0"));
          requestedIds.push(...ids);
          return encodeRelicRows(ids.map((tokenId) => ({ tokenId, owner })));
        },
      },
    });
    const torii = createMockToriiTransport({
      tokens: ({ offset = 0, limit = 100 }) => ({
        totalCount: totalRows + 1,
        edges: Array.from({ length: Math.min(limit, totalRows - offset) }, (_, index) => {
          const tokenId = BigInt(offset + index + 1);
          return { node: { tokenMetadata: toriiToken(tokenId, SEPOLIA_DEV_PRESET.contracts.RelicNFT, !missingIds.has(tokenId)) } };
        }),
      }),
    });
    const metadata = createMockMetadataTransport(Object.fromEntries(
      Array.from(missingIds, (tokenId) => [`ipfs://metadata-${tokenId}`, {
        name: `Hydrated #${tokenId}`,
        image: `ipfs://image-${tokenId}`,
        attributes: [{ trait_type: "Power", value: 8 }],
      }]),
    ));
    const client = createCageCallsClient({ network: SEPOLIA_DEV_PRESET, transports: { rpc, torii, metadata } });

    const response = await client.relics.collection({ pageSize: 200, enrichFighters: false });

    expect(response.data.items).toHaveLength(totalRows);
    expect(new Set(requestedIds)).toEqual(missingIds);
    expect(requestedIds).toHaveLength(missingIds.size);
    expect(response.meta.complete).toBe(true);
  });

  it("uses configurable aggregate batches instead of one RPC call per relic", async () => {
    const rpc = createMockRpcTransport({
      calls: {
        max_relic_batch_size: ["0"],
        get_relics: (request) => {
          const calldata = request.calldata ?? [];
          const count = Number(calldata[0] ?? "0");
          const ids = Array.from({ length: count }, (_, index) => BigInt(calldata[1 + index * 2] ?? "0"));
          return encodeRelicRows(ids.map((tokenId) => ({ tokenId, owner })));
        },
      },
    });
    const client = createCageCallsClient({ network: SEPOLIA_DEV_PRESET, transports: { rpc } });

    await client.relics.getMany(Array.from({ length: 205 }, (_, index) => BigInt(index + 1)));
    await client.relics.getMany(Array.from({ length: 130 }, (_, index) => BigInt(index + 1)), { relicBatchSize: 64 });

    const sizes = rpc.calls
      .filter((call) => call.entrypoint === "get_relics")
      .map((call) => Number(call.calldata?.[0]));
    expect(sizes).toEqual([100, 100, 5, 64, 64, 2]);
    expect(rpc.calls.filter((call) => call.entrypoint === "max_relic_batch_size")).toHaveLength(1);
  });

  it("splits oversized aggregate calls adaptively", async () => {
    const rpc = createMockRpcTransport({
      calls: {
        max_relic_batch_size: ["0"],
        get_relics: (request) => {
          const calldata = request.calldata ?? [];
          const count = Number(calldata[0] ?? "0");
          if (count > 25) throw new Error("response too large");
          const ids = Array.from({ length: count }, (_, index) => BigInt(calldata[1 + index * 2] ?? "0"));
          return encodeRelicRows(ids.map((tokenId) => ({ tokenId, owner })));
        },
      },
    });
    const client = createCageCallsClient({ network: SEPOLIA_DEV_PRESET, transports: { rpc } });

    const response = await client.relics.getMany(
      Array.from({ length: 60 }, (_, index) => BigInt(index + 1)),
      { relicBatchSize: 60 },
    );

    expect(response.data).toHaveLength(60);
    expect(response.meta.warnings.map((warning) => warning.code)).toContain("RELIC_BATCH_SPLIT");
    expect(rpc.calls.filter((call) => call.entrypoint === "get_relics").map((call) => Number(call.calldata?.[0])))
      .toEqual([60, 30, 15, 15, 30, 15, 15]);
  });

  it("keeps inventory reads off external metadata gateways", async () => {
    const rpc = createMockRpcTransport({
      calls: {
        next_token_id: ["3", "0"],
        max_relic_batch_size: ["0"],
        get_relics: encodeRelicRows([{ tokenId: 2n, owner }]),
      },
    });
    const torii = createMockToriiTransport({
      tokens: {
        totalCount: 2,
        edges: [{ node: { tokenMetadata: toriiToken(1n, SEPOLIA_DEV_PRESET.contracts.RelicNFT) } }],
      },
    });
    const metadata = createMockMetadataTransport({
      "ipfs://metadata-2": { name: "Two", image: "ipfs://two", attributes: [] },
    });
    const getJson = vi.spyOn(metadata, "getJson");
    const client = createCageCallsClient({ network: SEPOLIA_DEV_PRESET, transports: { rpc, torii, metadata } });

    const response = await client.relics.inventory({ enrichFighters: false });

    expect(response.data.items.map((relic) => relic.tokenId)).toEqual([2n, 1n]);
    expect(response.meta.complete).toBe(true);
    expect(getJson).not.toHaveBeenCalled();
  });

  it("marks an empty Torii inventory unverified when no aggregate fallback is deployed", async () => {
    const rpc = createMockRpcTransport();
    const torii = createMockToriiTransport({ tokens: { totalCount: 0, edges: [] } });
    const client = createCageCallsClient({ network: "mainnet", transports: { rpc, torii } });

    const response = await client.relics.feed();

    expect(response.data.items).toEqual([]);
    expect(response.meta.complete).toBe(false);
    expect(response.meta.warnings.map((warning) => warning.code)).toContain("TORII_INVENTORY_UNVERIFIED");
    expect(rpc.calls).toEqual([]);
  });

  it("accepts complete Torii ownership only after balance verification and skips other metadata sources", async () => {
    const rpc = createMockRpcTransport({ calls: { balance_of: ["2", "0"] } });
    const torii = createMockToriiTransport({
      tokenBalances: {
        totalCount: 2,
        edges: [2n, 1n].map((tokenId) => ({ node: { tokenMetadata: toriiToken(tokenId, MAINNET_PRESET.contracts.RelicNFT) } })),
      },
    });
    const client = createCageCallsClient({ network: "mainnet", transports: { rpc, torii } });

    const response = await client.relics.owned(owner);

    expect(response.data.provenance).toMatchObject({ ownershipSource: "torii", verified: true, onchainBalance: 2n });
    expect(response.data.items.map((relic) => relic.tokenId)).toEqual([2n, 1n]);
    expect(rpc.calls.map((value) => value.entrypoint)).toEqual(["balance_of"]);
  });

  it("filters Torii token-balance totals to the RelicNFT contract before comparing ownership", async () => {
    const rpc = createMockRpcTransport({ calls: { balance_of: ["21", "0"] } });
    const relics = Array.from({ length: 21 }, (_, index) => ({
      node: { tokenMetadata: toriiToken(BigInt(index + 1), MAINNET_PRESET.contracts.RelicNFT) },
    }));
    const unrelated = Array.from({ length: 8 }, (_, index) => ({
      node: { tokenMetadata: toriiToken(BigInt(index + 1), MAINNET_PRESET.contracts.StrikeTickets) },
    }));
    const torii = createMockToriiTransport({
      tokenBalances: { totalCount: 50, edges: [...relics, ...unrelated] },
    });
    const client = createCageCallsClient({ network: "mainnet", transports: { rpc, torii } });

    const response = await client.relics.owned(owner);

    expect(response.data.items).toHaveLength(21);
    expect(response.data.provenance).toMatchObject({ onchainBalance: 21n, verified: true, ownershipSource: "torii" });
    expect(rpc.calls.map((value) => value.entrypoint)).toEqual(["balance_of"]);
  });

  it("keeps verified Torii ownership when optional metadata hydration fails", async () => {
    const rpc = createMockRpcTransport({
      calls: {
        balance_of: ["2", "0"],
        get_relics: new Error("legacy deployment"),
      },
    });
    const torii = createMockToriiTransport({
      tokenBalances: {
        totalCount: 2,
        edges: [
          { node: { tokenMetadata: toriiToken(2n, MAINNET_PRESET.contracts.RelicNFT, true) } },
          { node: { tokenMetadata: toriiToken(1n, MAINNET_PRESET.contracts.RelicNFT, false) } },
        ],
      },
    });
    const client = createCageCallsClient({ network: "mainnet", transports: { rpc, torii } });

    const response = await client.relics.owned(owner);

    expect(response.data.items.map((relic) => relic.tokenId)).toEqual([2n, 1n]);
    expect(response.data.provenance).toMatchObject({ onchainBalance: 2n, verified: true, ownershipSource: "torii" });
    expect(response.meta.complete).toBe(false);
    expect(response.meta.warnings.map((warning) => warning.code)).toContain("TORII_METADATA_HYDRATION_FAILED");
  });

  it("hydrates only incomplete Torii metadata with the batch RPC view", async () => {
    const rpc = createMockRpcTransport({
      calls: {
        balance_of: ["2", "0"],
        get_relics: (request) => request.calldata?.[0] === "0"
          ? ["0"]
          : encodeRelicRows([{ tokenId: 1n, owner }]),
      },
    });
    const torii = createMockToriiTransport({
      tokenBalances: {
        totalCount: 2,
        edges: [
          { node: { tokenMetadata: toriiToken(2n, MAINNET_PRESET.contracts.RelicNFT, true) } },
          { node: { tokenMetadata: toriiToken(1n, MAINNET_PRESET.contracts.RelicNFT, false) } },
        ],
      },
    });
    const metadata = createMockMetadataTransport({
      "ipfs://metadata-1": { name: "Hydrated Relic", image: "ipfs://image", attributes: [{ trait_type: "Power", value: 8 }] },
    });
    const { preset: _preset, ...probingMainnet } = MAINNET_PRESET;
    const client = createCageCallsClient({ network: probingMainnet, transports: { rpc, torii, metadata } });

    const response = await client.relics.owned(owner);

    expect(response.data.items.find((relic) => relic.tokenId === 1n)?.name).toBe("Hydrated Relic");
    expect(rpc.calls.filter((value) => value.entrypoint === "get_relics")).toHaveLength(2);
  });

  it("falls through Torii disagreement to bounded owner RPC", async () => {
    const rpc = createMockRpcTransport({
      calls: {
        balance_of: ["2", "0"],
        get_owned_relics: (request) => request.calldata?.[3] === "0"
          ? encodeOwnedPage([])
          : encodeOwnedPage([{ tokenId: 2n, owner }, { tokenId: 1n, owner }]),
      },
    });
    const torii = createMockToriiTransport({
      tokenBalances: { totalCount: 1, edges: [{ node: { tokenMetadata: toriiToken(99n, SEPOLIA_DEV_PRESET.contracts.RelicNFT) } }] },
    });
    const metadata = createMockMetadataTransport({
      "ipfs://metadata-1": { name: "One", image: "ipfs://one", attributes: [{ trait_type: "Power", value: 1 }] },
      "ipfs://metadata-2": { name: "Two", image: "ipfs://two", attributes: [{ trait_type: "Power", value: 2 }] },
    });
    const upgraded = {
      ...SEPOLIA_DEV_PRESET,
      name: "Upgraded test",
      deploymentRevision: "test",
      capabilities: { ...SEPOLIA_DEV_PRESET.capabilities, relicOwnerPage: true },
    };
    const client = createCageCallsClient({ network: upgraded, transports: { rpc, torii, metadata } });

    const response = await client.relics.owned(owner);

    expect(response.data.provenance).toMatchObject({ ownershipSource: "starknet-rpc", verified: true });
    expect(response.data.items.map((relic) => relic.tokenId)).toEqual([2n, 1n]);
    expect(response.meta.warnings.map((warning) => warning.code)).toContain("TORII_BALANCE_MISMATCH");
  });

  it("continues owner RPC pagination across empty windows until the verified balance is found", async () => {
    const rpc = createMockRpcTransport({
      calls: {
        balance_of: ["1", "0"],
        get_owned_relics: (request) => {
          const cursor = BigInt(request.calldata?.[1] ?? "0");
          if (cursor === 0n) return encodeOwnedPage([], 800n);
          if (cursor === 800n) return encodeOwnedPage([], 600n);
          return encodeOwnedPage([{ tokenId: 1n, owner }], 400n);
        },
      },
    });
    const upgraded = {
      ...SEPOLIA_DEV_PRESET,
      capabilities: { ...SEPOLIA_DEV_PRESET.capabilities, relicOwnerPage: true },
    };
    const client = createCageCallsClient({ network: upgraded, transports: { rpc } });

    const response = await client.relics.owned(owner);

    expect(response.data.items.map((relic) => relic.tokenId)).toEqual([1n]);
    expect(response.data.provenance).toMatchObject({ onchainBalance: 1n, verified: true });
    expect(response.data.hasMore).toBe(false);
    expect(rpc.calls.filter((call) => call.entrypoint === "get_owned_relics")).toHaveLength(3);
  });

  it("stops a repeated owner cursor and reports the inventory as partial", async () => {
    const rpc = createMockRpcTransport({
      calls: {
        balance_of: ["2", "0"],
        get_owned_relics: (request) => request.calldata?.[3] === "0"
          ? encodeOwnedPage([])
          : request.calldata?.[1] === "0"
            ? encodeOwnedPage([{ tokenId: 1n, owner }], 800n)
            : encodeOwnedPage([], 800n),
      },
    });
    const upgraded = {
      ...SEPOLIA_DEV_PRESET,
      capabilities: { ...SEPOLIA_DEV_PRESET.capabilities, relicOwnerPage: true },
    };
    const client = createCageCallsClient({ network: upgraded, transports: { rpc } });

    const response = await client.relics.owned(owner);

    expect(response.data.items.map((relic) => relic.tokenId)).toEqual([1n]);
    expect(response.data.provenance).toMatchObject({ onchainBalance: 2n, verified: false });
    expect(response.data.hasMore).toBe(true);
    expect(response.meta.complete).toBe(false);
    expect(response.meta.warnings.map((warning) => warning.code)).toEqual(expect.arrayContaining([
      "RPC_CURSOR_STALLED",
      "RPC_BALANCE_MISMATCH",
    ]));
  });

  it("verifies historical Torii candidates through owner_of on legacy deployments", async () => {
    const rpc = createMockRpcTransport({
      calls: {
        balance_of: ["21", "0"],
        get_owned_relics: new Error("legacy deployment"),
        get_relic_feed: new Error("legacy deployment"),
        owner_of: (request) => BigInt(request.calldata?.[0] ?? "0") <= 21n ? [owner] : ["0x999"],
      },
    });
    const torii = createMockToriiTransport({
      tokenBalances: {
        totalCount: 50,
        edges: Array.from({ length: 50 }, (_, index) => ({
          node: { tokenMetadata: toriiToken(BigInt(index + 1), MAINNET_PRESET.contracts.RelicNFT) },
        })),
      },
      tokens: new Error("global token inventory must not be required"),
    });
    const client = createCageCallsClient({ network: "mainnet", transports: { rpc, torii } });

    const response = await client.relics.owned(owner);

    expect(response.data.items).toHaveLength(21);
    expect(response.data.provenance).toMatchObject({ onchainBalance: 21n, verified: true, ownershipSource: "starknet-rpc" });
    expect(response.data.hasMore).toBe(false);
    expect(response.meta.complete).toBe(true);
    expect(response.meta.warnings.map((warning) => warning.code)).toEqual(expect.arrayContaining([
      "TORII_BALANCE_MISMATCH",
      "TORII_CANDIDATE_RPC_VERIFICATION",
    ]));
    expect(rpc.calls.filter((value) => value.entrypoint === "owner_of")).toHaveLength(50);
  });

  it("returns capped verified candidates as partial data instead of throwing", async () => {
    const rpc = createMockRpcTransport({
      calls: {
        balance_of: ["3", "0"],
        get_owned_relics: new Error("legacy deployment"),
        get_relic_feed: new Error("legacy deployment"),
        owner_of: [owner],
      },
    });
    const torii = createMockToriiTransport({
      tokenBalances: {
        totalCount: 4,
        edges: [1n, 2n].map((tokenId) => ({
          node: { tokenMetadata: toriiToken(tokenId, MAINNET_PRESET.contracts.RelicNFT) },
        })),
      },
    });
    const client = createCageCallsClient({
      network: "mainnet",
      transports: { rpc, torii },
      budget: { maxToriiPages: 1, pageSize: 2, maxRpcItems: 2 },
    });

    const response = await client.relics.owned(owner);

    expect(response.data.items).toHaveLength(2);
    expect(response.data.hasMore).toBe(true);
    expect(response.data.provenance).toMatchObject({ onchainBalance: 3n, verified: false });
    expect(response.meta.complete).toBe(false);
    expect(response.meta.warnings.map((warning) => warning.code)).toContain("RPC_BALANCE_MISMATCH");
  });
});
