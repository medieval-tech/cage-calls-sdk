import { beforeEach, describe, expect, it } from "vitest";

import {
  clearLockedOddsCutoverCache,
  isLockedOddsFight,
  resolveLockedOddsCutover,
} from "../src/repositories/locked-odds.js";
import type { RepositoryContext } from "../src/repositories/index.js";

function contextWith(call: () => Promise<{ data: string[] }>): { context: RepositoryContext; calls: () => number } {
  let count = 0;
  const context = {
    network: { chainId: "TEST_CHAIN", contracts: { FightFactory: "0xff" } },
    rpc: {
      call: async () => {
        count += 1;
        return call();
      },
    },
    now: () => Date.now(),
  } as unknown as RepositoryContext;
  return { context, calls: () => count };
}

describe("resolveLockedOddsCutover", () => {
  beforeEach(() => clearLockedOddsCutoverCache());

  it("caches a non-zero cutover forever", async () => {
    const { context, calls } = contextWith(async () => ({ data: ["0x15", "0x0"] }));
    expect(await resolveLockedOddsCutover(context)).toBe(21n);
    expect(await resolveLockedOddsCutover(context)).toBe(21n);
    expect(calls()).toBe(1);
  });

  it("caches a missing entrypoint (pre-upgrade class) as legacy", async () => {
    const { context, calls } = contextWith(async () => {
      throw new Error("Requested entrypoint does not exist in the contract");
    });
    expect(await resolveLockedOddsCutover(context)).toBe(0n);
    expect(await resolveLockedOddsCutover(context)).toBe(0n);
    expect(calls()).toBe(1);
  });

  it("recognizes the transport-wrapped RPC_21 form as a missing entrypoint", async () => {
    const { context, calls } = contextWith(async () => {
      throw new Error("RPC request failed (RPC_21).");
    });
    expect(await resolveLockedOddsCutover(context)).toBe(0n);
    expect(await resolveLockedOddsCutover(context)).toBe(0n);
    expect(calls()).toBe(1);
  });

  it("does NOT cache transient failures — the next read retries the chain", async () => {
    let failures = 1;
    const { context, calls } = contextWith(async () => {
      if (failures > 0) {
        failures -= 1;
        throw new Error("Request aborted.");
      }
      return { data: ["0x15", "0x0"] };
    });
    // Aborted read falls back to legacy for this call only...
    expect(await resolveLockedOddsCutover(context)).toBe(0n);
    // ...and the very next read recovers the real cutover.
    expect(await resolveLockedOddsCutover(context)).toBe(21n);
    expect(calls()).toBe(2);
  });
});

describe("isLockedOddsFight", () => {
  it("treats zero cutover as inactive for every fight", () => {
    expect(isLockedOddsFight(0n, 1n)).toBe(false);
  });
  it("gates by fight id at or above the cutover", () => {
    expect(isLockedOddsFight(21n, 20n)).toBe(false);
    expect(isLockedOddsFight(21n, 21n)).toBe(true);
  });
});
