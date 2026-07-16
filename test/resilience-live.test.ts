import { describe, expect, it, vi } from "vitest";

import {
  TransportError,
  createLiveRepository,
  createRequestCoalescer,
  createResilientRpcTransport,
  createSourceStatusRegistry,
  type CageCallsLiveObserver,
  type CageCallsLiveTransport,
  type RpcTransport,
} from "../src/index.js";

describe("read resilience", () => {
  it("coalesces identical work only while it is in flight", async () => {
    const coalescer = createRequestCoalescer();
    let resolve!: (value: number) => void;
    const task = vi.fn(() => new Promise<number>((done) => { resolve = done; }));
    const first = coalescer.run("same", undefined, task);
    const second = coalescer.run("same", undefined, task);
    expect(task).toHaveBeenCalledTimes(1);
    expect(coalescer.size).toBe(1);
    resolve(7);
    await expect(Promise.all([first, second])).resolves.toEqual([7, 7]);
    await coalescer.run("same", undefined, async () => 8);
    expect(task).toHaveBeenCalledTimes(1);
    expect(coalescer.size).toBe(0);
  });

  it("opens a passive circuit immediately on rate limiting without probing", async () => {
    let requests = 0;
    const base: RpcTransport = {
      async request() {
        requests += 1;
        throw new TransportError("starknet-rpc", "rate limited", { status: 429 });
      },
      async call() { throw new Error("unused"); },
      async getClassHashAt() { throw new Error("unused"); },
    };
    const registry = createSourceStatusRegistry();
    const rpc = createResilientRpcTransport(base, registry, { failureThreshold: 2, cooldownMs: 60_000, now: () => 1_000 });
    await expect(rpc.request("one")).rejects.toThrow("rate limited");
    await expect(rpc.request("two")).rejects.toMatchObject({ transportCode: "CIRCUIT_OPEN" });
    expect(requests).toBe(1);
    expect(registry.get("rpc")).toMatchObject({ state: "open", consecutiveFailures: 1, retryAt: 61_000 });
  });

  it("closes the circuit and clears stale diagnostics after a successful half-open request", async () => {
    let now = 1_000;
    let fail = true;
    const base: RpcTransport = {
      async request<T>() {
        if (fail) throw new TransportError("starknet-rpc", "rate limited", { status: 429 });
        return { data: 42 as T, attempts: [] };
      },
      async call() { throw new Error("unused"); },
      async getClassHashAt() { throw new Error("unused"); },
    };
    const registry = createSourceStatusRegistry();
    const rpc = createResilientRpcTransport(base, registry, { failureThreshold: 1, cooldownMs: 100, now: () => now });
    await expect(rpc.request("first")).rejects.toThrow("rate limited");
    expect(registry.get("rpc")).toMatchObject({ state: "open", retryAt: 1_100, lastErrorCode: "HTTP_429" });
    now = 1_100;
    fail = false;
    await expect(rpc.request<number>("retry")).resolves.toMatchObject({ data: 42 });
    expect(registry.get("rpc")).toMatchObject({ state: "closed", consecutiveFailures: 0 });
    expect(registry.get("rpc").retryAt).toBeUndefined();
    expect(registry.get("rpc").lastErrorCode).toBeUndefined();
  });
});

describe("typed live adapter", () => {
  it("filters updates and emits one reconciliation after reconnect", async () => {
    let observer!: CageCallsLiveObserver;
    const transport: CageCallsLiveTransport = {
      subscribe(value) {
        observer = value;
        return { unsubscribe() {} };
      },
    };
    const live = createLiveRepository(transport);
    const updates = vi.fn();
    await live.subscribe({ account: "0xabc" }, { update: updates });
    observer.status?.("connected");
    observer.update({ kind: "token-balance", account: "0xdef", token: "CALLS" });
    observer.update({ kind: "token-balance", account: "0xabc", token: "CALLS" });
    observer.status?.("reconnecting");
    observer.status?.("connected");
    observer.status?.("connected");
    expect(updates.mock.calls.map(([update]) => update.kind)).toEqual(["token-balance", "reconcile"]);
  });
});
