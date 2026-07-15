import { describe, expect, it, vi } from "vitest";

import {
  createCageCallsClient,
  createFallbackRpcTransport,
  createHttpRpcTransport,
  createIpfsMetadataTransport,
  createToriiGraphqlTransport,
  TransportError,
  type RpcTransport,
} from "../src/index.js";

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
  status,
  headers: { "content-type": "application/json" },
});

describe("RPC transports", () => {
  it("logs one summarized warning after every IPFS gateway fails", async () => {
    const logger = { warn: vi.fn() };
    const fetch = vi.fn(async () => new Response(null, { status: 503 }));
    const metadata = createIpfsMetadataTransport({
      gateways: ["https://one.example/ipfs", "https://two.example/ipfs"],
      fetch,
      logger,
    });

    await expect(metadata.getJson("ipfs://cid/metadata.json")).rejects.toBeInstanceOf(TransportError);

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenCalledOnce();
    expect(logger.warn).toHaveBeenCalledWith("Cage Calls IPFS metadata request failed.", {
      uri: "ipfs://cid/metadata.json",
      gatewayCount: 2,
      errorCodes: ["TRANSPORT_ERROR"],
    });
  });

  it("falls back from a failed primary and reports both bounded attempts", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
      const url = String(input);
      return url.includes("primary")
        ? json({ error: "down" }, 503)
        : json({ jsonrpc: "2.0", id: 1, result: ["0", "0"] });
    });
    const logger = { debug: vi.fn(), warn: vi.fn() };
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
    expect(logger.debug).toHaveBeenCalledWith("Cage Calls RPC call completed.", expect.objectContaining({
      contractAddress: "0x1",
      entrypoint: "balance_of",
      attemptCount: 2,
      retryCount: 1,
      fallback: true,
    }));
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain("secret-primary");
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain("secret-fallback");
    expect(JSON.stringify(logger.debug.mock.calls)).not.toContain("secret-primary");
    expect(JSON.stringify(logger.debug.mock.calls)).not.toContain("secret-fallback");
    expect(JSON.stringify(logger.debug.mock.calls)).not.toContain("0x2");
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

  it("does not duplicate a failed request when primary and fallback URLs normalize to the same endpoint", async () => {
    const fetch = vi.fn(async () => json({}, 429));
    const logger = { warn: vi.fn() };
    const rpc = createFallbackRpcTransport({
      primaryUrl: "https://rpc.example/path",
      fallbackUrl: "https://rpc.example/path/../path",
      fetch,
      logger,
      maxRetries: 0,
    });

    const error = await rpc.request("starknet_blockNumber").catch((value: unknown) => value);

    expect(error).toMatchObject({ status: 429, transportCode: "HTTP_429" });
    expect(fetch).toHaveBeenCalledOnce();
    expect(logger.warn.mock.calls.some(([message]) => message === "Cage Calls RPC fallback selected.")).toBe(false);
  });

  it("retries JSON-RPC 429 responses with bounded exponential backoff before fallback", async () => {
    let calls = 0;
    const fetch = vi.fn(async () => {
      calls += 1;
      return calls < 3
        ? json({ jsonrpc: "2.0", id: calls, error: { code: 429, message: "rate limited" } })
        : json({ jsonrpc: "2.0", id: calls, result: 42 });
    });
    const rpc = createHttpRpcTransport({
      url: "https://rpc.example",
      fetch,
      maxRetries: 2,
      retryBaseDelayMs: 1,
    });

    const response = await rpc.request<number>("starknet_blockNumber");

    expect(response.data).toBe(42);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(response.attempts.map((value) => [value.ok, value.errorCode])).toEqual([
      [false, "RPC_429"],
      [false, "RPC_429"],
      [true, undefined],
    ]);
  });

  it("traces standalone RPC entrypoints without logging calldata", async () => {
    const logger = { debug: vi.fn() };
    const rpc = createHttpRpcTransport({
      url: "https://rpc.example/secret-key",
      fetch: vi.fn(async () => json({ jsonrpc: "2.0", id: 1, result: ["1"] })),
      logger,
    });

    await rpc.call({ contractAddress: "0x123", entrypoint: "get_market", calldata: ["0xdeadbeef"] });

    expect(logger.debug).toHaveBeenCalledWith("Cage Calls RPC call completed.", expect.objectContaining({
      contractAddress: "0x123",
      entrypoint: "get_market",
      attemptCount: 1,
      retryCount: 0,
      fallback: false,
    }));
    expect(JSON.stringify(logger.debug.mock.calls)).not.toContain("secret-key");
    expect(JSON.stringify(logger.debug.mock.calls)).not.toContain("deadbeef");
  });

  it("does not fall back or warn when the caller aborts the primary request", async () => {
    const controller = new AbortController();
    const logger = { warn: vi.fn() };
    const fetch = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
    }));
    const rpc = createFallbackRpcTransport({
      primaryUrl: "https://primary.example",
      fallbackUrl: "https://fallback.example",
      fetch,
      logger,
    });

    const pending = rpc.request("starknet_blockNumber", [], { signal: controller.signal });
    controller.abort();
    const error = await pending.catch((value: unknown) => value);

    expect(error).toMatchObject({ transportCode: "ABORTED" });
    expect(fetch).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("preserves Starknet JSON-RPC codes in errors, attempts, and sanitized logs", async () => {
    const logger = { warn: vi.fn() };
    const rpc = createHttpRpcTransport({
      url: "https://rpc.example/secret",
      fetch: vi.fn(async () => json({ jsonrpc: "2.0", id: 1, error: { code: -32601, message: "Method not found" } })),
      logger,
    });

    const error = await rpc.request("starknet_call").catch((value: unknown) => value);

    expect(error).toMatchObject({ rpcCode: -32601, transportCode: "RPC_-32601" });
    expect(error).toMatchObject({ attempts: [{ errorCode: "RPC_-32601" }] });
    expect(logger.warn).toHaveBeenCalledWith("Cage Calls RPC request failed.", {
      method: "starknet_call",
      errorCode: "RPC_-32601",
      rpcCode: -32601,
    });
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain("secret");
  });

  it("bounds concurrent requests per RPC endpoint", async () => {
    let active = 0;
    let peak = 0;
    const fetch = vi.fn(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return json({ jsonrpc: "2.0", id: 1, result: 1 });
    });
    const rpc = createHttpRpcTransport({ url: "https://rpc.example", fetch, maxConcurrency: 2 });

    await Promise.all(Array.from({ length: 8 }, () => rpc.request("starknet_blockNumber")));

    expect(fetch).toHaveBeenCalledTimes(8);
    expect(peak).toBe(2);
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

  it("detects legacy Torii offset pagination and returns stable cursors", async () => {
    const requests: Array<{ query: string; variables: Record<string, unknown> }> = [];
    const fetch = vi.fn<typeof globalThis.fetch>(async (_input, init) => {
      const request = JSON.parse(String(init?.body)) as { query: string; variables: Record<string, unknown> };
      requests.push(request);
      if (request.query.includes("first:$first")) {
        return json({ errors: [{ message: "Unknown argument first" }] });
      }
      const offset = Number(request.variables.offset ?? 0);
      return json({
        data: {
          pmFightModels: {
            totalCount: 3,
            pageInfo: { hasNextPage: true, endCursor: null },
            edges: [{ cursor: `legacy-${offset}`, node: { fight_id: String(offset + 1) } }],
          },
        },
      });
    });
    const torii = createToriiGraphqlTransport({ url: "https://torii.example", fetch });

    const first = await torii.model<{ fight_id: string }>({
      model: "Fight",
      selection: ["fight_id"],
      first: 1,
    });
    const second = await torii.model<{ fight_id: string }>({
      model: "Fight",
      selection: ["fight_id"],
      first: 1,
      after: first.data.pageInfo.endCursor!,
    });

    expect(first.data.pageInfo).toEqual({ hasNextPage: true, endCursor: "offset:1" });
    expect(first.attempts).toHaveLength(2);
    expect(first.attempts[1]?.fallback).toBe(true);
    expect(second.data.edges[0]?.node.fight_id).toBe("2");
    expect(requests).toHaveLength(3);
    expect(requests[2]?.variables.offset).toBe(1);
  });

  it("traces Torii model pages without logging filters or endpoints", async () => {
    const logger = { debug: vi.fn() };
    const fetch = vi.fn<typeof globalThis.fetch>(async () => json({
      data: {
        pmMarketModels: {
          totalCount: 1,
          pageInfo: { hasNextPage: false, endCursor: null },
          edges: [{ cursor: "market-1", node: { market_id: "1" } }],
        },
      },
    }));
    const torii = createToriiGraphqlTransport({
      url: "https://torii.example/secret-path",
      fetch,
      logger,
    });

    await torii.model({
      model: "Market",
      selection: ["market_id"],
      first: 20,
      where: { creator: "0xsecret-filter" },
    });

    expect(logger.debug).toHaveBeenCalledWith("Cage Calls Torii model query completed.", expect.objectContaining({
      model: "Market",
      itemCount: 1,
      totalCount: 1,
      hasNextPage: false,
      paginationDialect: "relay",
      attemptCount: 1,
      fallback: false,
    }));
    expect(JSON.stringify(logger.debug.mock.calls)).not.toContain("secret-path");
    expect(JSON.stringify(logger.debug.mock.calls)).not.toContain("secret-filter");
  });

  it("does not retry a failed HTTP request as a pagination dialect change", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(null, { status: 503 }));
    const torii = createToriiGraphqlTransport({ url: "https://torii.example", fetch });

    await expect(torii.model({ model: "Fight", selection: ["fight_id"], first: 1 }))
      .rejects.toMatchObject({ code: "TRANSPORT_ERROR", status: 503 });
    expect(fetch).toHaveBeenCalledOnce();
  });
});
