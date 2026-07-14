import { describe, expect, it } from "vitest";

describe("runtime boundaries", () => {
  it("imports the root in an SSR-like process without browser globals", async () => {
    expect("window" in globalThis).toBe(false);
    const sdk = await import("../src/index.js");
    expect(typeof sdk.createCageCallsClient).toBe("function");
  });

  it("keeps React out of the root module graph", async () => {
    const source = await import("node:fs/promises").then((fs) => fs.readFile(new URL("../src/index.ts", import.meta.url), "utf8"));
    expect(source).not.toMatch(/react|tanstack/i);
  });
});
