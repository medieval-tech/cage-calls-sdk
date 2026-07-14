import { describe, expect, it } from "vitest";

import {
  CairoReader,
  DecodeError,
  ValidationError,
  decodeGachaPoolStateRpc,
  decodeU256,
  encodeByteArray,
  encodeU256,
  normalizeAddress,
  selectorFromName,
} from "../src/index.js";

describe("Cairo codecs", () => {
  it("encodes the full u256 range and rejects overflow", () => {
    const maximum = (1n << 256n) - 1n;
    const encoded = encodeU256(maximum);
    expect(decodeU256(encoded[0]!, encoded[1]!)).toBe(maximum);
    expect(() => encodeU256(maximum + 1n)).toThrow(ValidationError);
  });

  it("round trips multi-word UTF-8 ByteArrays", () => {
    const value = "Cage Calls — a ByteArray longer than thirty-one bytes";
    const reader = new CairoReader(encodeByteArray(value));
    expect(reader.byteArray()).toBe(value);
    reader.done();
  });

  it("throws DecodeError for truncated ByteArrays", () => {
    expect(() => new CairoReader(["1", "123"]).byteArray()).toThrow(DecodeError);
  });

  it("matches Starknet keccak selectors", () => {
    expect(selectorFromName("transfer")).toBe("0x83afd3f4caedc6eebf44246fe54e38c95e3179a5ec9ea81740eca5b482d12e");
  });

  it("normalizes equivalent addresses", () => {
    expect(normalizeAddress("15")).toBe("0xf");
    expect(normalizeAddress("0x000f")).toBe("0xf");
  });

  it("decodes aggregate gacha pool state", () => {
    const encoded = [
      ...encodeU256(7n), "1", ...encodeU256(2n), "2",
      "0", ...encodeU256(1n), ...encodeU256(1n), ...encodeU256(0n),
      "6", ...encodeU256(1n), ...encodeU256(1n), ...encodeU256(1n),
    ];
    expect(decodeGachaPoolStateRpc(encoded)).toEqual({
      fightId: 7n,
      open: true,
      size: 2n,
      rarities: [
        { rarity: 0, expected: 1n, registered: 1n, available: 0n },
        { rarity: 6, expected: 1n, registered: 1n, available: 1n },
      ],
    });
  });
});
