import { DecodeError, ValidationError } from "./errors.js";
import type { Address, Felt, Hex } from "./types.js";

const U128_MASK = (1n << 128n) - 1n;
const U256_MAX = (1n << 256n) - 1n;
const FELT_MAX = 3618502788666131213697322783095070105623107215331596699973092056135872020480n;
const ADDRESS_MAX = (1n << 251n) - 1n;
const KECCAK_MASK = (1n << 64n) - 1n;
const SELECTOR_MASK = (1n << 250n) - 1n;

const ROUND_CONSTANTS = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an,
  0x8000000080008000n, 0x000000000000808bn, 0x0000000080000001n,
  0x8000000080008081n, 0x8000000000008009n, 0x000000000000008an,
  0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n,
  0x8000000000008003n, 0x8000000000008002n, 0x8000000000000080n,
  0x000000000000800an, 0x800000008000000an, 0x8000000080008081n,
  0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
] as const;

const ROTATIONS = [
  0, 1, 62, 28, 27,
  36, 44, 6, 55, 20,
  3, 10, 43, 25, 39,
  41, 45, 15, 21, 8,
  18, 2, 61, 56, 14,
] as const;

function rotateLeft(value: bigint, shift: number): bigint {
  if (shift === 0) return value & KECCAK_MASK;
  const amount = BigInt(shift);
  return ((value << amount) | (value >> (64n - amount))) & KECCAK_MASK;
}

function keccakPermutation(state: bigint[]): void {
  for (const roundConstant of ROUND_CONSTANTS) {
    const c = new Array<bigint>(5);
    const d = new Array<bigint>(5);
    for (let x = 0; x < 5; x += 1) {
      c[x] = (state[x] ?? 0n) ^ (state[x + 5] ?? 0n) ^ (state[x + 10] ?? 0n)
        ^ (state[x + 15] ?? 0n) ^ (state[x + 20] ?? 0n);
    }
    for (let x = 0; x < 5; x += 1) {
      d[x] = (c[(x + 4) % 5] ?? 0n) ^ rotateLeft(c[(x + 1) % 5] ?? 0n, 1);
    }
    for (let x = 0; x < 5; x += 1) {
      for (let y = 0; y < 5; y += 1) {
        const index = x + 5 * y;
        state[index] = (state[index] ?? 0n) ^ (d[x] ?? 0n);
      }
    }

    const b = new Array<bigint>(25).fill(0n);
    for (let x = 0; x < 5; x += 1) {
      for (let y = 0; y < 5; y += 1) {
        const targetX = y;
        const targetY = (2 * x + 3 * y) % 5;
        b[targetX + 5 * targetY] = rotateLeft(state[x + 5 * y] ?? 0n, ROTATIONS[x + 5 * y] ?? 0);
      }
    }

    for (let x = 0; x < 5; x += 1) {
      for (let y = 0; y < 5; y += 1) {
        const index = x + 5 * y;
        state[index] = (b[index] ?? 0n) ^ ((~(b[(x + 1) % 5 + 5 * y] ?? 0n)) & (b[(x + 2) % 5 + 5 * y] ?? 0n));
      }
    }
    state[0] = (state[0] ?? 0n) ^ roundConstant;
  }
}

function keccak256(bytes: Uint8Array): Uint8Array {
  const rate = 136;
  const paddedLength = Math.ceil((bytes.length + 1) / rate) * rate;
  const padded = new Uint8Array(paddedLength);
  padded.set(bytes);
  padded[bytes.length] = 0x01;
  padded[padded.length - 1] = (padded[padded.length - 1] ?? 0) | 0x80;

  const state = new Array<bigint>(25).fill(0n);
  for (let offset = 0; offset < padded.length; offset += rate) {
    for (let lane = 0; lane < rate / 8; lane += 1) {
      let value = 0n;
      for (let byte = 0; byte < 8; byte += 1) {
        value |= BigInt(padded[offset + lane * 8 + byte] ?? 0) << BigInt(byte * 8);
      }
      state[lane] = (state[lane] ?? 0n) ^ value;
    }
    keccakPermutation(state);
  }

  const output = new Uint8Array(32);
  for (let index = 0; index < output.length; index += 1) {
    output[index] = Number(((state[Math.floor(index / 8)] ?? 0n) >> BigInt((index % 8) * 8)) & 0xffn);
  }
  return output;
}

function bytesToBigInt(bytes: Uint8Array): bigint {
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  return value;
}

export function selectorFromName(entrypoint: string): Felt {
  if (!entrypoint) throw new ValidationError("Entrypoint name is required.");
  return `0x${(bytesToBigInt(keccak256(new TextEncoder().encode(entrypoint))) & SELECTOR_MASK).toString(16)}`;
}

export function asBigInt(value: string | number | bigint, label = "value"): bigint {
  try {
    const parsed = typeof value === "bigint" ? value : BigInt(value);
    return parsed;
  } catch {
    throw new ValidationError(`${label} must be an integer.`, { label });
  }
}

export function toHex(value: string | number | bigint): Hex {
  const parsed = asBigInt(value);
  if (parsed < 0n) throw new ValidationError("Hex value cannot be negative.");
  return `0x${parsed.toString(16)}`;
}

export function normalizeFelt(value: string | number | bigint, label = "felt"): Felt {
  const parsed = asBigInt(value, label);
  if (parsed < 0n || parsed > FELT_MAX) throw new ValidationError(`${label} is outside the felt252 range.`);
  return toHex(parsed);
}

export function normalizeAddress(value: string | number | bigint, label = "address"): Address {
  const parsed = asBigInt(value, label);
  if (parsed < 0n || parsed > ADDRESS_MAX) throw new ValidationError(`${label} is outside the Starknet address range.`);
  return toHex(parsed);
}

export function sameAddress(left: string, right: string): boolean {
  try {
    return normalizeAddress(left) === normalizeAddress(right);
  } catch {
    return false;
  }
}

export function encodeU256(value: string | number | bigint): string[] {
  const parsed = asBigInt(value, "u256");
  if (parsed < 0n || parsed > U256_MAX) throw new ValidationError("u256 is outside the valid range.");
  return [(parsed & U128_MASK).toString(), (parsed >> 128n).toString()];
}

/** Normalize an unsigned 256-bit value for Torii model filters. */
export function normalizeU256(value: string | number | bigint, label = "u256"): Hex {
  const parsed = asBigInt(value, label);
  if (parsed < 0n || parsed > U256_MAX) throw new ValidationError(`${label} is outside the u256 range.`);
  return toHex(parsed);
}

export function decodeU256(low: string | bigint, high: string | bigint): bigint {
  const lowValue = asBigInt(low, "u256.low");
  const highValue = asBigInt(high, "u256.high");
  if (lowValue < 0n || lowValue > U128_MASK || highValue < 0n || highValue > U128_MASK) {
    throw new DecodeError("Malformed u256 limbs.");
  }
  return lowValue + (highValue << 128n);
}

function bytesToFelt(bytes: Uint8Array): string {
  return bytesToBigInt(bytes).toString();
}

export function encodeByteArray(value: string): string[] {
  const bytes = new TextEncoder().encode(value);
  const fullWords = Math.floor(bytes.length / 31);
  const output = [fullWords.toString()];
  for (let index = 0; index < fullWords; index += 1) {
    output.push(bytesToFelt(bytes.slice(index * 31, index * 31 + 31)));
  }
  const pending = bytes.slice(fullWords * 31);
  output.push(bytesToFelt(pending), pending.length.toString());
  return output;
}

export function encodeShortString(value: string): Felt {
  const bytes = new TextEncoder().encode(value);
  if (bytes.length > 31) throw new ValidationError("Short string cannot exceed 31 UTF-8 bytes.");
  return toHex(bytesToBigInt(bytes));
}

export function decodeShortString(value: string | bigint): string {
  let parsed = asBigInt(value);
  if (parsed === 0n) return "";
  const bytes: number[] = [];
  while (parsed > 0n) {
    bytes.unshift(Number(parsed & 0xffn));
    parsed >>= 8n;
  }
  return new TextDecoder(undefined, { fatal: true }).decode(new Uint8Array(bytes));
}

export class CairoReader {
  private index = 0;
  readonly values: readonly string[];

  constructor(values: readonly string[], private readonly context = "RPC result") {
    this.values = values;
  }

  get position(): number {
    return this.index;
  }

  get remaining(): number {
    return this.values.length - this.index;
  }

  felt(label = "felt"): string {
    const value = this.values[this.index++];
    if (value === undefined) throw new DecodeError(`${this.context} ended while reading ${label}.`, { position: this.index - 1 });
    try {
      return normalizeFelt(value, label);
    } catch (cause) {
      throw new DecodeError(`${this.context} contains an invalid ${label}.`, { position: this.index - 1 }, { cause });
    }
  }

  address(label = "address"): Address {
    const value = this.felt(label);
    try {
      return normalizeAddress(value, label);
    } catch (cause) {
      throw new DecodeError(`${this.context} contains an invalid ${label}.`, { position: this.index - 1 }, { cause });
    }
  }

  bigint(label = "integer"): bigint {
    return BigInt(this.felt(label));
  }

  number(label = "number"): number {
    const value = this.bigint(label);
    const number = Number(value);
    if (!Number.isSafeInteger(number)) throw new DecodeError(`${label} is not a safe integer.`);
    return number;
  }

  u256(label = "u256"): bigint {
    return decodeU256(this.felt(`${label}.low`), this.felt(`${label}.high`));
  }

  bool(label = "bool"): boolean {
    const value = this.bigint(label);
    if (value !== 0n && value !== 1n) throw new DecodeError(`${label} is not a Cairo bool.`);
    return value === 1n;
  }

  byteArray(label = "ByteArray"): string {
    const count = this.number(`${label}.data.len`);
    const bytes: number[] = [];
    for (let index = 0; index < count; index += 1) {
      const word = this.bigint(`${label}.data[${index}]`);
      for (let byte = 30; byte >= 0; byte -= 1) bytes.push(Number((word >> BigInt(byte * 8)) & 0xffn));
    }
    const pendingWord = this.bigint(`${label}.pendingWord`);
    const pendingLength = this.number(`${label}.pendingLength`);
    if (pendingLength < 0 || pendingLength > 30) throw new DecodeError(`${label} pending length is invalid.`);
    for (let byte = pendingLength - 1; byte >= 0; byte -= 1) bytes.push(Number((pendingWord >> BigInt(byte * 8)) & 0xffn));
    try {
      return new TextDecoder(undefined, { fatal: true }).decode(new Uint8Array(bytes));
    } catch (cause) {
      throw new DecodeError(`${label} is not valid UTF-8.`, undefined, { cause });
    }
  }

  done(): void {
    if (this.remaining !== 0) throw new DecodeError(`${this.context} has ${this.remaining} trailing felt(s).`, { position: this.index });
  }
}

export function clampPageSize(value: number | undefined, maximum: number, fallback: number): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1) throw new ValidationError("Page size must be a positive safe integer.");
  return Math.min(result, maximum);
}

export function redactUrl(value: string): string {
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}/…`;
  } catch {
    return "<redacted-url>";
  }
}

export function ipfsPath(uri: string): string | undefined {
  const value = uri.trim();
  if (value.startsWith("ipfs://")) return value.slice(7).replace(/^ipfs\//, "");
  if (/^(Qm[1-9A-HJ-NP-Za-km-z]{44}|bafy[a-zA-Z0-9]+)(\/.*)?$/.test(value)) return value;
  return undefined;
}
