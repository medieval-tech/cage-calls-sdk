import { describe, expect, it, vi } from "vitest";

import {
  createCageCallsClient,
  createFallbackRpcTransport,
  createHttpRpcTransport,
  createToriiGraphqlTransport,
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

  it("does not retry a failed HTTP request as a pagination dialect change", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(null, { status: 503 }));
    const torii = createToriiGraphqlTransport({ url: "https://torii.example", fetch });

    await expect(torii.model({ model: "Fight", selection: ["fight_id"], first: 1 }))
      .rejects.toMatchObject({ code: "TRANSPORT_ERROR", status: 503 });
    expect(fetch).toHaveBeenCalledOnce();
  });
});
