import { createCageCallsClient, type CageCallsClient, type CreateCageCallsClientOptions } from "./client.js";
import { MAINNET_PRESET } from "./network.js";
import type {
  MetadataTransport,
  RpcCall,
  RpcTransport,
  ToriiConnection,
  ToriiModelRequest,
  ToriiRawEvent,
  ToriiTokenBalanceConnection,
  ToriiTokenConnection,
  ToriiTransport,
  TransportResult,
} from "./transports.js";
import type { Address, Felt, RequestOptions, SourceAttempt } from "./types.js";

const ok = <T>(data: T, source: SourceAttempt["source"], operation: string): TransportResult<T> => ({
  data,
  attempts: [{ source, operation, ok: true, durationMs: 0 }],
});

export interface MockRpcTransport extends RpcTransport {
  calls: RpcCall[];
  requests: Array<{ method: string; params?: readonly unknown[] | Record<string, unknown> }>;
}

export function createMockRpcTransport(input: {
  calls?: Record<string, readonly string[] | Error | ((call: RpcCall) => readonly string[])>;
  requests?: Record<string, unknown | Error>;
  classHashes?: Record<string, Felt>;
} = {}): MockRpcTransport {
  const calls: RpcCall[] = [];
  const requests: MockRpcTransport["requests"] = [];
  return {
    calls,
    requests,
    async request<T>(method: string, params?: readonly unknown[] | Record<string, unknown>) {
      requests.push({ method, ...(params === undefined ? {} : { params }) });
      const value = input.requests?.[method];
      if (value instanceof Error) throw value;
      if (value === undefined) throw new Error(`Unhandled mock RPC request ${method}`);
      return ok(value as T, "starknet-rpc", method);
    },
    async call(call) {
      calls.push(call);
      const key = `${call.contractAddress}:${call.entrypoint}`;
      const value = input.calls?.[key] ?? input.calls?.[call.entrypoint];
      if (value instanceof Error) throw value;
      if (value === undefined) throw new Error(`Unhandled mock RPC call ${key}`);
      return ok(Array.from(typeof value === "function" ? value(call) : value), "starknet-rpc", call.entrypoint);
    },
    async getClassHashAt(address) {
      const value = input.classHashes?.[address];
      if (!value) throw new Error(`Unhandled class hash ${address}`);
      return ok(value, "starknet-rpc", "starknet_getClassHashAt");
    },
  };
}

export function createMockToriiTransport(input: {
  models?: Record<string, ToriiConnection<Record<string, unknown>> | Error>;
  events?: ToriiConnection<ToriiRawEvent> | Error;
  tokenBalances?: ToriiTokenBalanceConnection | Error;
  tokens?: ToriiTokenConnection | Error;
} = {}): ToriiTransport {
  return {
    async query<T>() { throw new Error("Raw mock Torii query is not configured."); },
    async model<T>(request: ToriiModelRequest) {
      const value = input.models?.[request.model];
      if (value instanceof Error) throw value;
      return ok((value ?? { edges: [], totalCount: 0, pageInfo: { hasNextPage: false } }) as ToriiConnection<T>, "torii", `model:${request.model}`);
    },
    async events() {
      if (input.events instanceof Error) throw input.events;
      return ok(input.events ?? { edges: [], totalCount: 0, pageInfo: { hasNextPage: false } }, "torii", "events");
    },
    async tokenBalances() {
      if (input.tokenBalances instanceof Error) throw input.tokenBalances;
      return ok(input.tokenBalances ?? { edges: [], totalCount: 0 }, "torii", "tokenBalances");
    },
    async tokens() {
      if (input.tokens instanceof Error) throw input.tokens;
      return ok(input.tokens ?? { edges: [], totalCount: 0 }, "torii", "tokens");
    },
  };
}

export function createMockMetadataTransport(fixtures: Record<string, unknown> = {}): MetadataTransport {
  return {
    resolve(uri) { return uri.replace(/^ipfs:\/\//, "https://ipfs.test/"); },
    async getJson<T>(uri: string, _options?: RequestOptions) {
      if (!(uri in fixtures)) throw new Error(`Unhandled metadata URI ${uri}`);
      return ok(fixtures[uri] as T, "ipfs", "metadata");
    },
  };
}

export function createTestClient(options: Partial<CreateCageCallsClientOptions> & { rpc?: RpcTransport } = {}): CageCallsClient {
  const rpc = options.rpc ?? createMockRpcTransport();
  return createCageCallsClient({
    network: options.network ?? MAINNET_PRESET,
    transports: options.transports ?? { rpc },
    ...(options.budget ? { budget: options.budget } : {}),
    ...(options.logger ? { logger: options.logger } : {}),
    now: options.now ?? (() => 1_700_000_000_000),
  });
}

export const fixtureAddress = (value: bigint): Address => `0x${value.toString(16)}`;
