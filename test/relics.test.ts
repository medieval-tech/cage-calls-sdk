import { describe, expect, it, vi } from "vitest";

import { createCageCallsClient, MAINNET_PRESET, SEPOLIA_DEV_PRESET } from "../src/index.js";
import {
  createMockAlchemyNftTransport,
  createMockMetadataTransport,
  createMockRpcTransport,
  createMockToriiTransport,
} from "../src/testing.js";
import { encodeOwnedPage, encodeRelicRows, toriiToken } from "./fixtures.js";

const owner = "0x123" as const;

describe("relic ownership source policy", () => {
  it("accepts complete Torii ownership only after balance verification and skips other metadata sources", async () => {
    const rpc = createMockRpcTransport({ calls: { balance_of: ["2", "0"] } });
    const nft = createMockAlchemyNftTransport({ owned: [] });
    const ownedNfts = vi.spyOn(nft, "ownedNfts");
    const torii = createMockToriiTransport({
      tokenBalances: {
        totalCount: 2,
        edges: [2n, 1n].map((tokenId) => ({ node: { tokenMetadata: toriiToken(tokenId, MAINNET_PRESET.contracts.RelicNFT) } })),
      },
    });
    const client = createCageCallsClient({ network: "mainnet", transports: { rpc, torii, nft } });

    const response = await client.relics.owned(owner);

    expect(response.data.provenance).toMatchObject({ ownershipSource: "torii", verified: true, onchainBalance: 2n });
    expect(response.data.items.map((relic) => relic.tokenId)).toEqual([2n, 1n]);
    expect(ownedNfts).not.toHaveBeenCalled();
    expect(rpc.calls.map((value) => value.entrypoint)).toEqual(["balance_of"]);
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
    const client = createCageCallsClient({ network: "mainnet", transports: { rpc, torii, metadata } });

    const response = await client.relics.owned(owner);

    expect(response.data.items.find((relic) => relic.tokenId === 1n)?.name).toBe("Hydrated Relic");
    expect(rpc.calls.filter((value) => value.entrypoint === "get_relics")).toHaveLength(2);
  });

  it("falls through Torii disagreement and unsupported Alchemy to bounded owner RPC", async () => {
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
    const nft = createMockAlchemyNftTransport({ supported: false, owned: [] });
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
    const client = createCageCallsClient({ network: upgraded, transports: { rpc, torii, nft, metadata } });

    const response = await client.relics.owned(owner);

    expect(response.data.provenance).toMatchObject({ ownershipSource: "starknet-rpc", verified: true });
    expect(response.data.items.map((relic) => relic.tokenId)).toEqual([2n, 1n]);
    expect(response.meta.warnings.map((warning) => warning.code)).toContain("TORII_BALANCE_MISMATCH");
  });
});
