import { DecodeError } from "../core/errors.js";

// Torii's SQL tables store every felt, address and u256 as `0x` + 64 lowercase hex digits,
// u64 as `0x` + 16 digits, and u8/bool as integers. These helpers write literals in that form
// and do the arithmetic SQLite cannot: it has no hex parser and only 64-bit integers.

/** A felt, address or u256 literal in Torii's stored form. */
export function sqlFelt(value: bigint | string): string {
  return `'0x${BigInt(value).toString(16).padStart(64, "0")}'`;
}

export function sqlFelts(values: readonly (bigint | string)[]): string {
  return values.map(sqlFelt).join(", ");
}

export function sqlText(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/** A stored hex value without `0x` and leading zeros, so wide columns travel as a few characters. */
export function sqlTrimmedHex(column: string): string {
  return `ltrim(substr(${column}, 3), '0')`;
}

export function parseTrimmedHex(value: string): bigint {
  return BigInt(`0x${value || "0"}`);
}

const nibble = (column: string, position: number) => `(instr('0123456789abcdef', substr(${column}, ${position}, 1)) - 1)`;
const ZERO_HIGH_HALF = `'${"0".repeat(32)}'`;

const CHUNKS = [0, 1, 2, 3, 4, 5, 6, 7];

/**
 * Exact SUM of a u256 column below 2^128: the low 128 bits are summed as eight 16-bit chunks and
 * recombined by `readU128Sum`. Each chunk sum stays an exact JSON number (below 2^53) up to 2^37
 * rows per group. `<alias>w` counts values with a non-zero high half, which `readU128Sum` rejects
 * instead of truncating.
 */
export function sqlU128Sum(column: string, alias: string): string {
  const chunks = CHUNKS.map((chunk) => {
    const digits = Array.from({ length: 4 }, (_, digit) => `${nibble(column, 35 + chunk * 4 + digit)} * ${16 ** (3 - digit)}`);
    return `SUM(${digits.join(" + ")}) AS ${alias}${chunk}`;
  });
  return [...chunks, `SUM(substr(${column}, 3, 32) != ${ZERO_HIGH_HALF}) AS ${alias}w`].join(", ");
}

export function readU128Sum(row: Record<string, unknown>, alias: string): bigint {
  if (Number(row[`${alias}w`] ?? 0) > 0) throw new DecodeError(`Torii SQL sum ${alias} includes a value of 2^128 or more.`);
  return CHUNKS.reduce((sum, chunk) => (sum << 16n) + BigInt(Number(row[`${alias}${chunk}`] ?? 0)), 0n);
}

/** Splits an IN list so a GET query stays far below URL length limits. */
export function sqlChunks<T>(values: readonly T[], size = 100): T[][] {
  const chunks: T[][] = [];
  for (let offset = 0; offset < values.length; offset += size) chunks.push(values.slice(offset, offset + size));
  return chunks;
}
