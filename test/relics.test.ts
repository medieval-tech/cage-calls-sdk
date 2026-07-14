import { describe, expect, it } from "vitest";

import { createCageCallsClient, MAINNET_PRESET, SEPOLIA_DEV_PRESET } from "../src/index.js";
import {
  createMockMetadataTransport,
  createMockRpcTransport,
  createMockToriiTransport,
} from "../src/testing.js";
import { encodeOwnedPage, encodeRelicRows, toriiToken } from "./fixtures.js";

const owner = "0x123" as const;

describe("relic ownership source policy", () => {
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
