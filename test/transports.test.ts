import { describe, expect, it, vi } from "vitest";

import {
  createCageCallsClient,
  createFallbackRpcTransport,
  createHttpRpcTransport,
  TransportError,
  type RpcTransport,
} from "../src/index.js";

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
  status,
  headers: { "content-type": "application/json" },
});

describe("RPC transports", () => {
  it("falls back from a failed primary and reports both bounded attempts", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
      const url = String(input);
      return url.includes("primary")
        ? json({ error: "down" }, 503)
        : json({ jsonrpc: "2.0", id: 1, result: ["0", "0"] });
    });
    const logger = { warn: vi.fn() };
    const rpc = createFallbackRpcTransport({
      primaryUrl: "https://primary.example/rpc/secret-primary",
      fallbackUrl: "https://fallback.example/rpc/secret-fallback",
      fetch,
      logger,
    });

    const response = await rpc.call({ contractAddress: "0x1", entrypoint: "balance_of", calldata: ["0x2"] });

    expect(response.data).toEqual(["0", "0"]);
    expect(response.attempts).toHaveLength(2);
    expect(response.attempts[1]?.fallback).toBe(true);
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain("secret-primary");
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain("secret-fallback");
  });

  it("does not expose authenticated endpoints in transport errors", async () => {
    const rpc = createHttpRpcTransport({
      url: "https://rpc.example/v0_9/super-secret-key",
      fetch: vi.fn(async () => json({}, 500)),
    });
    const error = await rpc.request("starknet_blockNumber").catch((value: unknown) => value);
    expect(error).toBeInstanceOf(TransportError);
    expect(String(error)).not.toContain("super-secret-key");
  });

  it("honors cancellation", async () => {
    const controller = new AbortController();
    const rpc = createHttpRpcTransport({
      url: "https://rpc.example",
      fetch: vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
      })),
    });
    const pending = rpc.request("starknet_blockNumber", [], { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toBeInstanceOf(TransportError);
  });

  it("records repository fallbacks through the client logger", async () => {
    const logger = { warn: vi.fn() };
    const rpc: RpcTransport = {
      async request() { throw new Error("unused"); },
      async getClassHashAt() { throw new Error("unused"); },
      async call() {
        return {
          data: ["1", "0"],
          attempts: [
            { source: "starknet-rpc", operation: "balance_of", ok: false, durationMs: 1, errorCode: "DOWN" },
            { source: "starknet-rpc", operation: "balance_of", ok: true, durationMs: 1, fallback: true },
          ],
        };
      },
    };
    const client = createCageCallsClient({ network: "mainnet", transports: { rpc }, logger });
    await client.tokens.callsBalance("0x1");
    expect(logger.warn).toHaveBeenCalledOnce();
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain("http");
  });
});
