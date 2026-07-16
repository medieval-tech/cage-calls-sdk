import { errorCode, withTimeout } from "./core.js";
import { normalizeAddress, normalizeFelt, redactUrl, selectorFromName } from "./codecs.js";
import { ConfigurationError, TransportError, ValidationError } from "./errors.js";
import type { Address, DataSource, Felt, RequestOptions, SdkLogger, SourceAttempt } from "./types.js";

export interface TransportResult<T> {
  data: T;
  attempts: SourceAttempt[];
  blockNumber?: bigint;
}

export interface RpcCall {
  contractAddress: Address;
  entrypoint: string;
  calldata?: readonly (string | number | bigint)[];
  blockId?: "latest" | "pending" | { block_hash: Felt } | { block_number: number };
}

export interface RpcTransport {
  request<T>(method: string, params?: readonly unknown[] | Record<string, unknown>, options?: RequestOptions): Promise<TransportResult<T>>;
  call(input: RpcCall, options?: RequestOptions): Promise<TransportResult<string[]>>;
  getClassHashAt(address: Address, options?: RequestOptions): Promise<TransportResult<Felt>>;
}

export interface ToriiModelRequest {
  model: string;
  selection: readonly string[];
  first?: number;
  after?: string;
  where?: Record<string, unknown>;
  order?: Record<string, unknown>;
}

export interface ToriiConnection<T> {
  edges: Array<{ cursor: string; node: T }>;
  totalCount: number;
  pageInfo: { hasNextPage: boolean; endCursor?: string };
}

export interface ToriiTransport {
  query<T>(document: string, variables?: Record<string, unknown>, options?: RequestOptions): Promise<TransportResult<T>>;
  model<T>(request: ToriiModelRequest, options?: RequestOptions): Promise<TransportResult<ToriiConnection<T>>>;
  events(request?: { first?: number; after?: string; keys?: string[] }, options?: RequestOptions): Promise<TransportResult<ToriiConnection<ToriiRawEvent>>>;
  tokenBalances(account: Address, request?: { offset?: number; limit?: number }, options?: RequestOptions): Promise<TransportResult<ToriiTokenBalanceConnection>>;
  tokens(contract: Address, request?: { offset?: number; limit?: number }, options?: RequestOptions): Promise<TransportResult<ToriiTokenConnection>>;
}

export interface ToriiRawEvent {
  id: string;
  keys: string[];
  data: string[];
  executedAt?: string;
  createdAt?: string;
  transactionHash?: string;
}

export interface ToriiTokenNode {
  __typename?: string;
  tokenId?: string;
  contractAddress?: string;
  metadata?: string | null;
  metadataName?: string | null;
  metadataDescription?: string | null;
  metadataAttributes?: string | null;
  imagePath?: string | null;
}

export interface ToriiTokenBalanceConnection {
  totalCount: number;
  edges: Array<{ node: { balance?: string; tokenMetadata?: ToriiTokenNode | null } }>;
}

export interface ToriiTokenConnection {
  totalCount: number;
  edges: Array<{ node: { tokenMetadata?: ToriiTokenNode | null } }>;
}

export interface MetadataTransport {
  resolve(uri: string): string;
  getJson<T = unknown>(uri: string, options?: RequestOptions): Promise<TransportResult<T>>;
}

interface HttpOptions {
  fetch?: typeof fetch;
  headers?: Readonly<Record<string, string>>;
  logger?: SdkLogger;
  timeoutMs?: number;
  maxConcurrency?: number;
  maxRetries?: number;
  retryBaseDelayMs?: number;
  endpointRole?: "direct" | "primary" | "fallback";
}

interface HttpRpcOptions extends HttpOptions {
  url: string;
}

function resolveFetch(value?: typeof fetch): typeof fetch {
  const implementation = value ?? globalThis.fetch;
  if (!implementation) throw new ConfigurationError("A fetch implementation is required.");
  return implementation;
}

function attempt(source: DataSource, operation: string, startedAt: number, ok: boolean, extra: Partial<SourceAttempt> = {}): SourceAttempt {
  return { source, operation, durationMs: Math.max(0, Date.now() - startedAt), ok, ...extra };
}

function abortError(): Error {
  const error = new Error("Request aborted.");
  error.name = "AbortError";
  return error;
}

function retryAfterMs(response: Response): number | undefined {
  const value = response.headers.get("retry-after")?.trim();
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}

function waitForRetry(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timeout);
      reject(abortError());
    };
    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function createConcurrencyGate(limit: number): (signal?: AbortSignal) => Promise<() => void> {
  let active = 0;
  const queue: Array<{
    signal?: AbortSignal;
    resolve: (release: () => void) => void;
    reject: (error: unknown) => void;
    onAbort?: () => void;
  }> = [];

  const drain = () => {
    while (active < limit && queue.length > 0) {
      const waiter = queue.shift();
      if (!waiter) break;
      if (waiter.onAbort) waiter.signal?.removeEventListener("abort", waiter.onAbort);
      if (waiter.signal?.aborted) {
        waiter.reject(abortError());
        continue;
      }
      active += 1;
      let released = false;
      waiter.resolve(() => {
        if (released) return;
        released = true;
        active -= 1;
        drain();
      });
    }
  };

  return (signal?: AbortSignal) => {
    if (signal?.aborted) return Promise.reject(abortError());
    return new Promise<() => void>((resolve, reject) => {
      const waiter: (typeof queue)[number] = { resolve, reject, ...(signal ? { signal } : {}) };
      if (signal) {
        waiter.onAbort = () => {
          const index = queue.indexOf(waiter);
          if (index >= 0) queue.splice(index, 1);
          reject(abortError());
        };
        signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
      queue.push(waiter);
      drain();
    });
  };
}

function transportDiagnosticCode(error: unknown): string {
  if (error instanceof TransportError && error.transportCode) return error.transportCode;
  if (error instanceof TransportError && error.rpcCode !== undefined) return `RPC_${error.rpcCode}`;
  if (error instanceof TransportError && error.status !== undefined) return `HTTP_${error.status}`;
  return errorCode(error);
}

function transportLogContext(
  method: string,
  error: TransportError,
  endpoint: string,
  endpointRole: "direct" | "primary" | "fallback",
): Readonly<Record<string, unknown>> {
  return {
    method,
    endpoint: redactUrl(endpoint),
    endpointRole,
    errorCode: transportDiagnosticCode(error),
    ...(error.status === undefined ? {} : { status: error.status }),
    ...(error.rpcCode === undefined ? {} : { rpcCode: error.rpcCode }),
  };
}

function rpcCallLogContext(
  input: RpcCall,
  startedAt: number,
  attempts: readonly SourceAttempt[],
  error?: unknown,
): Readonly<Record<string, unknown>> {
  return {
    contractAddress: normalizeAddress(input.contractAddress),
    entrypoint: input.entrypoint,
    durationMs: Math.max(0, Date.now() - startedAt),
    attemptCount: attempts.length,
    retryCount: attempts.filter((value) => !value.ok).length,
    fallback: attempts.some((value) => value.fallback),
    ...(error === undefined ? {} : { errorCode: transportDiagnosticCode(error) }),
  };
}

function validateHttpUrl(value: string, label: string): string {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("protocol");
    return url.toString();
  } catch {
    throw new ConfigurationError(`${label} must be an HTTP(S) URL.`);
  }
}

function toriiAddress(value: Address): string {
  return `0x${normalizeAddress(value).slice(2).padStart(64, "0")}`;
}

export function createHttpRpcTransport(options: HttpRpcOptions): RpcTransport {
  const endpoint = validateHttpUrl(options.url, "RPC URL");
  const fetchImpl = resolveFetch(options.fetch);
  const timeoutMs = options.timeoutMs ?? 12_000;
  const maxConcurrency = options.maxConcurrency ?? 8;
  const maxRetries = options.maxRetries ?? 2;
  const retryBaseDelayMs = options.retryBaseDelayMs ?? 500;
  const endpointRole = options.endpointRole ?? "direct";
  if (!Number.isSafeInteger(maxConcurrency) || maxConcurrency <= 0) {
    throw new ConfigurationError("RPC maxConcurrency must be a positive safe integer.");
  }
  if (!Number.isSafeInteger(maxRetries) || maxRetries < 0) {
    throw new ConfigurationError("RPC maxRetries must be a non-negative safe integer.");
  }
  if (!Number.isSafeInteger(retryBaseDelayMs) || retryBaseDelayMs <= 0) {
    throw new ConfigurationError("RPC retryBaseDelayMs must be a positive safe integer.");
  }
  const acquire = createConcurrencyGate(maxConcurrency);
  let id = 0;

  const request = async <T>(
    method: string,
    params: readonly unknown[] | Record<string, unknown> = [],
    requestOptions: RequestOptions = {},
  ): Promise<TransportResult<T>> => {
    const startedAt = Date.now();
    let requestStartedAt = startedAt;
    const retryAttempts: SourceAttempt[] = [];
    let release: (() => void) | undefined;
    let timeout: ReturnType<typeof withTimeout> | undefined;
    try {
      release = await acquire(requestOptions.signal);
      const requestTimeoutMs = requestOptions.timeoutMs === undefined
        ? timeoutMs
        : Math.min(timeoutMs, requestOptions.timeoutMs);
      timeout = withTimeout(requestOptions.signal, requestTimeoutMs);
      if (timeout.signal.aborted) throw abortError();
      for (let retry = 0; ; retry += 1) {
        requestStartedAt = Date.now();
        let serverDelayMs: number | undefined;
        try {
          const response = await fetchImpl(endpoint, {
            method: "POST",
            headers: { "content-type": "application/json", ...options.headers },
            body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
            signal: timeout.signal,
          });
          serverDelayMs = retryAfterMs(response);
          if (!response.ok) {
            throw new TransportError("starknet-rpc", `RPC request failed with HTTP ${response.status}.`, {
              status: response.status,
              transportCode: `HTTP_${response.status}`,
            });
          }
          const payload = await response.json() as { result?: T; error?: { code?: number; message?: string } };
          if (payload.error) {
            const code = payload.error.code === undefined ? "RPC_ERROR" : `RPC_${payload.error.code}`;
            throw new TransportError("starknet-rpc", `RPC request failed (${code}).`, {
              ...(payload.error.code === undefined ? {} : { rpcCode: payload.error.code }),
              transportCode: code,
            });
          }
          if (!("result" in payload)) throw new TransportError("starknet-rpc", "RPC response did not include a result.");
          return {
            data: payload.result as T,
            attempts: [...retryAttempts, attempt("starknet-rpc", method, requestStartedAt, true)],
          };
        } catch (cause) {
          const rateLimited = cause instanceof TransportError && (cause.status === 429 || cause.rpcCode === 429);
          if (!rateLimited || retry >= maxRetries || timeout.signal.aborted || requestOptions.signal?.aborted) throw cause;
          retryAttempts.push(attempt("starknet-rpc", method, requestStartedAt, false, {
            ...(cause.status === undefined ? {} : { status: cause.status }),
            errorCode: transportDiagnosticCode(cause),
          }));
          await waitForRetry(serverDelayMs ?? retryBaseDelayMs * (2 ** retry), timeout.signal);
        }
      }
    } catch (cause) {
      const transportCode = requestOptions.signal?.aborted
        ? "ABORTED"
        : timeout?.signal.aborted
          ? "TIMEOUT"
          : errorCode(cause);
      const transportError = cause instanceof TransportError
        ? cause
        : new TransportError("starknet-rpc", `RPC request failed (${transportCode}).`, { cause, transportCode });
      if (transportDiagnosticCode(transportError) !== "ABORTED") {
        options.logger?.warn?.("Cage Calls RPC request failed.", transportLogContext(method, transportError, endpoint, endpointRole));
      }
      Object.defineProperty(transportError, "attempts", {
        value: [...retryAttempts, attempt("starknet-rpc", method, requestStartedAt, false, {
          ...(transportError.status === undefined ? {} : { status: transportError.status }),
          errorCode: transportDiagnosticCode(transportError),
        })],
      });
      throw transportError;
    } finally {
      timeout?.cleanup();
      release?.();
    }
  };

  return {
    request,
    async call(input, requestOptions) {
      const startedAt = Date.now();
      const call = {
        contract_address: normalizeAddress(input.contractAddress),
        entry_point_selector: selectorFromName(input.entrypoint),
        calldata: (input.calldata ?? []).map((value) => normalizeFelt(value)),
      };
      try {
        const response = await request<string[]>("starknet_call", [call, input.blockId ?? "latest"], requestOptions);
        options.logger?.debug?.("Cage Calls RPC call completed.", rpcCallLogContext(input, startedAt, response.attempts));
        return response;
      } catch (error) {
        options.logger?.debug?.("Cage Calls RPC call failed.", rpcCallLogContext(input, startedAt, attemptsFromError(error), error));
        throw error;
      }
    },
    async getClassHashAt(address, requestOptions) {
      const result = await request<string>("starknet_getClassHashAt", ["latest", normalizeAddress(address)], requestOptions);
      return { ...result, data: normalizeFelt(result.data) };
    },
  };
}

function attemptsFromError(error: unknown): SourceAttempt[] {
  if (error && typeof error === "object" && "attempts" in error && Array.isArray(error.attempts)) {
    return error.attempts as SourceAttempt[];
  }
  return [];
}

export interface RpcPoolEndpoint {
  name: string;
  url: string;
  headers?: Readonly<Record<string, string>>;
}

/** Ordered RPC failover with independent overload/timeout cooldown per endpoint. */
export function createRpcPoolTransport(options: {
  endpoints: readonly RpcPoolEndpoint[];
  fetch?: typeof fetch;
  logger?: SdkLogger;
  timeoutMs?: number;
  maxConcurrency?: number;
  maxRetries?: number;
  retryBaseDelayMs?: number;
  cooldownMs?: number;
  now?: () => number;
}): RpcTransport {
  if (options.endpoints.length === 0) throw new ConfigurationError("RPC pool requires at least one endpoint.");
  const now = options.now ?? Date.now;
  const cooldownMs = options.cooldownMs ?? 30_000;
  const retryAt = options.endpoints.map(() => 0);
  const endpoints = options.endpoints.map((endpoint, index) => ({
    name: endpoint.name,
    url: validateHttpUrl(endpoint.url, `RPC pool endpoint ${endpoint.name}`),
    transport: createHttpRpcTransport({
      url: endpoint.url,
      endpointRole: index === 0 ? "primary" : "fallback",
      ...(endpoint.headers ? { headers: endpoint.headers } : {}),
      ...(options.fetch ? { fetch: options.fetch } : {}),
      ...(options.logger ? { logger: options.logger } : {}),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      ...(options.maxConcurrency === undefined ? {} : { maxConcurrency: options.maxConcurrency }),
      ...(options.maxRetries === undefined ? {} : { maxRetries: options.maxRetries }),
      ...(options.retryBaseDelayMs === undefined ? {} : { retryBaseDelayMs: options.retryBaseDelayMs }),
    }),
  }));
  const request = async <T>(method: string, params?: readonly unknown[] | Record<string, unknown>, requestOptions?: RequestOptions) => {
    const available = endpoints.map((_, index) => index).filter((index) => (retryAt[index] ?? 0) <= now());
    const candidates = available.length > 0
      ? available
      : [retryAt.reduce((best, value, index, values) => value < (values[best] ?? Number.POSITIVE_INFINITY) ? index : best, 0)];
    const attempts: SourceAttempt[] = [];
    let lastError: unknown;
    for (const index of candidates) {
      const endpoint = endpoints[index];
      if (!endpoint) continue;
      try {
        const response = await endpoint.transport.request<T>(method, params, requestOptions);
        retryAt[index] = 0;
        return { ...response, attempts: [...attempts, ...response.attempts.map((value) => ({ ...value, fallback: index > 0 }))] };
      } catch (error) {
        lastError = error;
        attempts.push(...attemptsFromError(error).map((value) => ({ ...value, fallback: index > 0 })));
        const code = transportDiagnosticCode(error).toUpperCase();
        if (error instanceof TransportError && (
          error.status === 408 || error.status === 429 || error.rpcCode === 429 || code.includes("TIMEOUT")
        )) retryAt[index] = now() + cooldownMs;
        if (requestOptions?.signal?.aborted || code === "ABORTED") break;
        options.logger?.warn?.("Cage Calls RPC pool selected the next endpoint.", {
          method,
          failedEndpoint: endpoint.name,
          failedEndpointUrl: redactUrl(endpoint.url),
          errorCode: code,
        });
      }
    }
    const error = lastError instanceof Error ? lastError : new TransportError("starknet-rpc", "Every RPC pool endpoint failed.");
    Object.defineProperty(error, "attempts", { value: attempts });
    throw error;
  };
  return {
    request,
    async call(input, requestOptions) {
      const call = {
        contract_address: normalizeAddress(input.contractAddress),
        entry_point_selector: selectorFromName(input.entrypoint),
        calldata: (input.calldata ?? []).map((value) => normalizeFelt(value)),
      };
      return request<string[]>("starknet_call", [call, input.blockId ?? "latest"], requestOptions);
    },
    async getClassHashAt(address, requestOptions) {
      const response = await request<string>("starknet_getClassHashAt", ["latest", normalizeAddress(address)], requestOptions);
      return { ...response, data: normalizeFelt(response.data) };
    },
  };
}

export function createFallbackRpcTransport(options: {
  primaryUrl?: string;
  fallbackUrl: string;
  fetch?: typeof fetch;
  headers?: Readonly<Record<string, string>>;
  logger?: SdkLogger;
  timeoutMs?: number;
  maxConcurrency?: number;
  maxRetries?: number;
  retryBaseDelayMs?: number;
  /** Cooldown applied to an overloaded/timed-out primary before it is probed again. */
  cooldownMs?: number;
  now?: () => number;
}): RpcTransport {
  const fallbackUrl = validateHttpUrl(options.fallbackUrl, "Fallback RPC URL");
  const primaryUrl = options.primaryUrl ? validateHttpUrl(options.primaryUrl, "Primary RPC URL") : undefined;
  const fallback = createHttpRpcTransport({
    url: fallbackUrl,
    endpointRole: "fallback",
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.headers ? { headers: options.headers } : {}),
    ...(options.logger ? { logger: options.logger } : {}),
    ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.maxConcurrency ? { maxConcurrency: options.maxConcurrency } : {}),
    ...(options.maxRetries === undefined ? {} : { maxRetries: options.maxRetries }),
    ...(options.retryBaseDelayMs === undefined ? {} : { retryBaseDelayMs: options.retryBaseDelayMs }),
  });
  const primary = primaryUrl && primaryUrl !== fallbackUrl
    ? createHttpRpcTransport({
        url: primaryUrl,
        endpointRole: "primary",
        ...(options.fetch ? { fetch: options.fetch } : {}),
        ...(options.headers ? { headers: options.headers } : {}),
        ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
        ...(options.maxConcurrency ? { maxConcurrency: options.maxConcurrency } : {}),
        ...(options.maxRetries === undefined ? {} : { maxRetries: options.maxRetries }),
        ...(options.retryBaseDelayMs === undefined ? {} : { retryBaseDelayMs: options.retryBaseDelayMs }),
      })
    : fallback;

  const now = options.now ?? Date.now;
  const cooldownMs = options.cooldownMs ?? 30_000;
  let primaryRetryAt = 0;
  const request = async <T>(method: string, params?: readonly unknown[] | Record<string, unknown>, requestOptions?: RequestOptions) => {
    if (primary !== fallback && primaryRetryAt > now()) {
      const result = await fallback.request<T>(method, params, requestOptions);
      return { ...result, attempts: result.attempts.map((value) => ({ ...value, fallback: true })) };
    }
    try {
      const result = await primary.request<T>(method, params, requestOptions);
      primaryRetryAt = 0;
      return result;
    } catch (primaryError) {
      if (primary === fallback) throw primaryError;
      if (requestOptions?.signal?.aborted || transportDiagnosticCode(primaryError) === "ABORTED") throw primaryError;
      const code = transportDiagnosticCode(primaryError).toUpperCase();
      if (primaryError instanceof TransportError && (
        primaryError.status === 408 || primaryError.status === 429 || primaryError.rpcCode === 429
        || code.includes("TIMEOUT")
      )) primaryRetryAt = now() + cooldownMs;
      options.logger?.warn?.("Cage Calls RPC fallback selected.", {
        method,
        primaryEndpoint: redactUrl(primaryUrl ?? fallbackUrl),
        fallbackEndpoint: redactUrl(fallbackUrl),
        selectedRole: "fallback",
        errorCode: transportDiagnosticCode(primaryError),
        ...(primaryError instanceof TransportError && primaryError.status !== undefined ? { status: primaryError.status } : {}),
        ...(primaryError instanceof TransportError && primaryError.rpcCode !== undefined ? { rpcCode: primaryError.rpcCode } : {}),
      });
      try {
        const result = await fallback.request<T>(method, params, requestOptions);
        const fallbackAttempts = result.attempts.map((value) => ({ ...value, fallback: true }));
        return { ...result, attempts: [...attemptsFromError(primaryError), ...fallbackAttempts] };
      } catch (fallbackError) {
        Object.defineProperty(fallbackError as object, "attempts", {
          value: [...attemptsFromError(primaryError), ...attemptsFromError(fallbackError).map((value) => ({ ...value, fallback: true }))],
        });
        throw fallbackError;
      }
    }
  };

  return {
    request,
    async call(input, requestOptions) {
      const startedAt = Date.now();
      const call = {
        contract_address: normalizeAddress(input.contractAddress),
        entry_point_selector: selectorFromName(input.entrypoint),
        calldata: (input.calldata ?? []).map((value) => normalizeFelt(value)),
      };
      try {
        const response = await request<string[]>("starknet_call", [call, input.blockId ?? "latest"], requestOptions);
        options.logger?.debug?.("Cage Calls RPC call completed.", rpcCallLogContext(input, startedAt, response.attempts));
        return response;
      } catch (error) {
        options.logger?.debug?.("Cage Calls RPC call failed.", rpcCallLogContext(input, startedAt, attemptsFromError(error), error));
        throw error;
      }
    },
    async getClassHashAt(address, requestOptions) {
      const result = await request<string>("starknet_getClassHashAt", ["latest", normalizeAddress(address)], requestOptions);
      return { ...result, data: normalizeFelt(result.data) };
    },
  };
}

const MODEL_NAME = /^[A-Za-z][A-Za-z0-9_]*$/;
const FIELD_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function createToriiGraphqlTransport(options: { url: string } & HttpOptions): ToriiTransport {
  const base = validateHttpUrl(options.url, "Torii URL").replace(/\/$/, "");
  const endpoint = base.endsWith("/graphql") ? base : `${base}/graphql`;
  const fetchImpl = resolveFetch(options.fetch);
  const timeoutMs = options.timeoutMs ?? 12_000;
  let modelPaginationDialect: "relay" | "offset" | undefined;
  let eventPaginationDialect: "relay" | "offset" | undefined;
  const tokenCountCache = new Map<string, { totalCount: number; expiresAt: number }>();

  const canRetryWithOffset = (error: unknown, signal?: AbortSignal) =>
    !signal?.aborted
    && error instanceof TransportError
    && error.status === undefined
    && error.cause === undefined;

  const query = async <T>(document: string, variables: Record<string, unknown> = {}, requestOptions: RequestOptions = {}) => {
    const startedAt = Date.now();
    const timeout = withTimeout(requestOptions.signal, timeoutMs);
    try {
      const response = await fetchImpl(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", ...options.headers },
        body: JSON.stringify({ query: document, variables }),
        signal: timeout.signal,
      });
      if (!response.ok) throw new TransportError("torii", `Torii request failed with HTTP ${response.status}.`, { status: response.status });
      const payload = await response.json() as { data?: T; errors?: Array<{ message?: string }> };
      if (payload.errors?.length) throw new TransportError("torii", `Torii GraphQL request failed (${payload.errors.length} error(s)).`);
      if (!payload.data) throw new TransportError("torii", "Torii GraphQL response did not include data.");
      return { data: payload.data, attempts: [attempt("torii", "graphql", startedAt, true)] };
    } catch (cause) {
      const transportError = cause instanceof TransportError
        ? cause
        : new TransportError("torii", `Torii request failed (${errorCode(cause)}).`, { cause });
      options.logger?.warn?.("Cage Calls Torii request failed.", { errorCode: errorCode(transportError) });
      Object.defineProperty(transportError, "attempts", {
        value: [attempt("torii", "graphql", startedAt, false, {
          ...(transportError.status === undefined ? {} : { status: transportError.status }),
          errorCode: errorCode(transportError),
        })],
      });
      throw transportError;
    } finally {
      timeout.cleanup();
    }
  };

  return {
    query,
    async model<T>(request: ToriiModelRequest, requestOptions?: RequestOptions) {
      const startedAt = Date.now();
      if (!MODEL_NAME.test(request.model) || request.selection.some((field: string) => !FIELD_NAME.test(field))) {
        throw new ValidationError("Torii model or selection contains an invalid GraphQL identifier.");
      }
      const field = `pm${request.model}Models`;
      const whereType = `pm_${request.model}WhereInput`;
      const orderType = `pm_${request.model}Order`;
      const optionalArguments = (declarations: string[], argumentsList: string[], variables: Record<string, unknown>) => {
        if (request.where) {
          declarations.push(`$where:${whereType}`);
          argumentsList.push("where:$where");
          variables.where = request.where;
        }
        if (request.order) {
          declarations.push(`$order:${orderType}`);
          argumentsList.push("order:$order");
          variables.order = request.order;
        }
      };
      const read = async (dialect: "relay" | "offset") => {
        const declarations = dialect === "relay" ? ["$first:Int"] : ["$offset:Int", "$limit:Int"];
        const argumentsList = dialect === "relay" ? ["first:$first"] : ["offset:$offset", "limit:$limit"];
        const pageSize = request.first ?? 100;
        const variables: Record<string, unknown> = dialect === "relay"
          ? { first: pageSize }
          : { offset: request.after?.startsWith("offset:") ? Number(request.after.slice(7)) : 0, limit: pageSize };
        if (dialect === "relay" && request.after) {
          declarations.push("$after:Cursor");
          argumentsList.push("after:$after");
          variables.after = request.after;
        }
        optionalArguments(declarations, argumentsList, variables);
        const document = `query CageCallsModel(${declarations.join(",")}){${field}(${argumentsList.join(",")}){totalCount pageInfo{hasNextPage endCursor} edges{cursor node{${request.selection.join(" ")}}}}}`;
        const response = await query<Record<string, ToriiConnection<T>>>(document, variables, requestOptions);
        const connection = response.data[field];
        if (!connection) throw new TransportError("torii", `Torii response omitted model ${request.model}.`);
        if (dialect === "offset") {
          const offset = Number(variables.offset);
          const nextOffset = offset + connection.edges.length;
          connection.pageInfo = {
            hasNextPage: nextOffset < connection.totalCount,
            ...(nextOffset < connection.totalCount ? { endCursor: `offset:${nextOffset}` } : {}),
          };
        }
        return { ...response, data: connection };
      };

      const trace = (response: TransportResult<ToriiConnection<T>>, dialect: "relay" | "offset") => {
        options.logger?.debug?.("Cage Calls Torii model query completed.", {
          model: request.model,
          itemCount: response.data.edges.length,
          totalCount: response.data.totalCount,
          hasNextPage: response.data.pageInfo.hasNextPage,
          paginationDialect: dialect,
          attemptCount: response.attempts.length,
          fallback: response.attempts.some((value) => value.fallback),
          durationMs: Math.max(0, Date.now() - startedAt),
        });
        return response;
      };

      if (modelPaginationDialect) return trace(await read(modelPaginationDialect), modelPaginationDialect);
      try {
        const response = await read("relay");
        modelPaginationDialect = "relay";
        return trace(response, "relay");
      } catch (relayError) {
        if (!canRetryWithOffset(relayError, requestOptions?.signal)) throw relayError;
        const response = await read("offset");
        modelPaginationDialect = "offset";
        return trace({
          ...response,
          attempts: [
            ...attemptsFromError(relayError),
            ...response.attempts.map((value) => ({ ...value, fallback: true })),
          ],
        }, "offset");
      }
    },
    async events(request = {}, requestOptions) {
      const read = async (dialect: "relay" | "offset") => {
        const document = dialect === "relay"
          ? "query CageCallsEvents($first:Int,$after:Cursor,$keys:[String!]){events(first:$first,after:$after,keys:$keys){totalCount pageInfo{hasNextPage endCursor} edges{cursor node{id keys data executedAt createdAt transactionHash}}}}"
          : "query CageCallsEvents($offset:Int,$limit:Int,$keys:[String!]){events(offset:$offset,limit:$limit,keys:$keys){totalCount pageInfo{hasNextPage endCursor} edges{cursor node{id keys data executedAt createdAt transactionHash}}}}";
        const pageSize = request.first ?? 100;
        const variables: Record<string, unknown> = dialect === "relay"
          ? { first: pageSize }
          : { offset: request.after?.startsWith("offset:") ? Number(request.after.slice(7)) : 0, limit: pageSize };
        if (dialect === "relay" && request.after) variables.after = request.after;
        if (request.keys) variables.keys = request.keys;
        const response = await query<{ events: ToriiConnection<ToriiRawEvent> }>(document, variables, requestOptions);
        const connection = response.data.events;
        if (dialect === "offset") {
          const offset = Number(variables.offset);
          const nextOffset = offset + connection.edges.length;
          connection.pageInfo = {
            hasNextPage: nextOffset < connection.totalCount,
            ...(nextOffset < connection.totalCount ? { endCursor: `offset:${nextOffset}` } : {}),
          };
        }
        return { ...response, data: connection };
      };
      if (eventPaginationDialect) return read(eventPaginationDialect);
      try {
        const response = await read("relay");
        eventPaginationDialect = "relay";
        return response;
      } catch (relayError) {
        if (!canRetryWithOffset(relayError, requestOptions?.signal)) throw relayError;
        const response = await read("offset");
        eventPaginationDialect = "offset";
        return {
          ...response,
          attempts: [
            ...attemptsFromError(relayError),
            ...response.attempts.map((value) => ({ ...value, fallback: true })),
          ],
        };
      }
    },
    async tokenBalances(account, request = {}, requestOptions) {
      const document = "query CageCallsBalances($account:String!,$offset:Int,$limit:Int){tokenBalances(accountAddress:$account,offset:$offset,limit:$limit){totalCount edges{node{tokenMetadata{__typename ... on ERC721__Token{tokenId contractAddress metadata metadataName metadataDescription metadataAttributes imagePath} ... on ERC1155__Token{tokenId contractAddress metadata metadataName metadataDescription metadataAttributes imagePath}}}}}}";
      const result = await query<{ tokenBalances: ToriiTokenBalanceConnection }>(document, {
        account: toriiAddress(account),
        offset: request.offset ?? 0,
        limit: request.limit ?? 100,
      }, requestOptions);
      return { ...result, data: result.data.tokenBalances };
    },
    async tokens(contract, request = {}, requestOptions) {
      // Torii includes a synthetic contract metadata row as the final token row.
      // Asking for a page that crosses that row can make large metadata responses
      // fail at the gateway. Read the cheap count first and bound the data page to
      // actual token rows.
      const countDocument = "query CageCallsTokenCount($contract:String){tokens(contractAddress:$contract,offset:0,limit:0){totalCount}}";
      const document = "query CageCallsTokens($contract:String,$offset:Int,$limit:Int){tokens(contractAddress:$contract,offset:$offset,limit:$limit){totalCount edges{node{tokenMetadata{__typename ... on ERC721__Token{tokenId contractAddress metadata metadataName metadataDescription metadataAttributes imagePath} ... on ERC1155__Token{tokenId contractAddress metadata metadataName metadataDescription metadataAttributes imagePath}}}}}}";
      const normalizedContract = toriiAddress(contract);
      const cachedCount = tokenCountCache.get(normalizedContract);
      const count = cachedCount && cachedCount.expiresAt > Date.now()
        ? undefined
        : await query<{ tokens: Pick<ToriiTokenConnection, "totalCount"> }>(countDocument, {
            contract: normalizedContract,
          }, requestOptions);
      if (count) tokenCountCache.set(normalizedContract, { totalCount: count.data.tokens.totalCount, expiresAt: Date.now() + 5_000 });
      const totalCount = count?.data.tokens.totalCount ?? cachedCount?.totalCount ?? 0;
      const offset = request.offset ?? 0;
      const requestedLimit = request.limit ?? 100;
      const tokenRows = Math.max(0, totalCount - 1);
      const limit = Math.max(0, Math.min(requestedLimit, tokenRows - offset));
      if (limit === 0) {
        return {
          data: { totalCount, edges: [] },
          attempts: count?.attempts ?? [],
        };
      }
      const result = await query<{ tokens: ToriiTokenConnection }>(document, {
        contract: normalizedContract,
        offset,
        limit,
      }, requestOptions);
      return {
        ...result,
        data: { ...result.data.tokens, totalCount },
        attempts: [...(count?.attempts ?? []), ...result.attempts],
      };
    },
  };
}

export function createIpfsMetadataTransport(options: { gateways: readonly string[] } & HttpOptions): MetadataTransport {
  if (options.gateways.length === 0) throw new ConfigurationError("At least one IPFS gateway is required.");
  const gateways = options.gateways.map((value) => validateHttpUrl(value, "IPFS gateway").replace(/\/?$/, "/"));
  const fetchImpl = resolveFetch(options.fetch);
  const timeoutMs = options.timeoutMs ?? 12_000;
  const resolve = (uri: string) => {
    const path = uri.trim().replace(/^ipfs:\/\/(ipfs\/)?/, "");
    if (/^https?:\/\//.test(uri)) return uri;
    return `${gateways[0]}${path}`;
  };

  return {
    resolve,
    async getJson<T>(uri: string, requestOptions: RequestOptions = {}) {
      const candidates = /^https?:\/\//.test(uri)
        ? [uri]
        : gateways.map((gateway) => `${gateway}${uri.trim().replace(/^ipfs:\/\/(ipfs\/)?/, "")}`);
      const attempts: SourceAttempt[] = [];
      const failureCodes = new Set<string>();
      for (let index = 0; index < candidates.length; index += 1) {
        const startedAt = Date.now();
        const timeout = withTimeout(requestOptions.signal, timeoutMs);
        try {
          const response = await fetchImpl(candidates[index] ?? "", { ...(options.headers ? { headers: options.headers } : {}), signal: timeout.signal });
          if (!response.ok) throw new TransportError("ipfs", `IPFS gateway request failed with HTTP ${response.status}.`, { status: response.status });
          const data = await response.json() as T;
          attempts.push(attempt("ipfs", "metadata", startedAt, true, index > 0 ? { fallback: true } : {}));
          return { data, attempts };
        } catch (cause) {
          const status = cause instanceof TransportError ? cause.status : undefined;
          failureCodes.add(errorCode(cause));
          attempts.push(attempt("ipfs", "metadata", startedAt, false, {
            ...(index > 0 ? { fallback: true } : {}),
            ...(status === undefined ? {} : { status }),
            errorCode: errorCode(cause),
          }));
          if (requestOptions.signal?.aborted) throw cause;
        } finally {
          timeout.cleanup();
        }
      }
      options.logger?.warn?.("Cage Calls IPFS metadata request failed.", {
        uri,
        gatewayCount: candidates.length,
        errorCodes: Array.from(failureCodes),
      });
      const error = new TransportError("ipfs", `All ${candidates.length} IPFS gateways failed.`);
      Object.defineProperty(error, "attempts", { value: attempts });
      throw error;
    },
  };
}

export const transportAttemptsFromError = attemptsFromError;
