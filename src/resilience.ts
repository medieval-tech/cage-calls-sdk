import { errorCode } from "./core.js";
import { TransportError } from "./errors.js";
import type {
  MetadataTransport,
  RpcCall,
  RpcTransport,
  ToriiModelRequest,
  ToriiTransport,
  TransportResult,
} from "./transports.js";
import type { RequestOptions } from "./types.js";

export type RuntimeSource = "rpc" | "torii" | "metadata";
export type CircuitState = "closed" | "open" | "half-open";

export interface SourceStatus {
  source: RuntimeSource;
  state: CircuitState;
  consecutiveFailures: number;
  lastSuccessAt?: number | undefined;
  lastFailureAt?: number | undefined;
  retryAt?: number | undefined;
  lastErrorCode?: string | undefined;
}

export interface SourceStatusRegistry {
  get(source: RuntimeSource): Readonly<SourceStatus>;
  snapshot(): Readonly<Record<RuntimeSource, Readonly<SourceStatus>>>;
  subscribe(listener: (status: Readonly<SourceStatus>) => void): () => void;
}

export interface PassiveCircuitOptions {
  failureThreshold?: number;
  cooldownMs?: number;
  now?: () => number;
}

interface MutableSourceStatus extends SourceStatus {}

export function createSourceStatusRegistry(): SourceStatusRegistry & {
  update(source: RuntimeSource, update: Partial<SourceStatus>): void;
} {
  const values: Record<RuntimeSource, MutableSourceStatus> = {
    rpc: { source: "rpc", state: "closed", consecutiveFailures: 0 },
    torii: { source: "torii", state: "closed", consecutiveFailures: 0 },
    metadata: { source: "metadata", state: "closed", consecutiveFailures: 0 },
  };
  const listeners = new Set<(status: Readonly<SourceStatus>) => void>();
  const copy = (value: SourceStatus): SourceStatus => ({ ...value });
  return {
    get(source) { return copy(values[source]); },
    snapshot() {
      return Object.freeze({ rpc: copy(values.rpc), torii: copy(values.torii), metadata: copy(values.metadata) });
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    update(source, update) {
      values[source] = { ...values[source], ...update, source };
      const status = copy(values[source]);
      for (const listener of listeners) listener(status);
    },
  };
}

function stable(value: unknown): string {
  if (typeof value === "bigint") return `bigint:${value}`;
  if (value === undefined) return "undefined";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`)
    .join(",")}}`;
}

function abortError(): Error {
  const error = new Error("Request aborted.");
  error.name = "AbortError";
  return error;
}

interface SharedRequest<T> {
  promise: Promise<T>;
  controller: AbortController;
  consumers: number;
  settled: boolean;
}

export interface RequestCoalescer {
  run<T>(key: string, signal: AbortSignal | undefined, task: (signal: AbortSignal) => Promise<T>): Promise<T>;
  readonly size: number;
}

export function createRequestCoalescer(): RequestCoalescer {
  const pending = new Map<string, SharedRequest<unknown>>();
  return {
    get size() { return pending.size; },
    async run<T>(key: string, signal: AbortSignal | undefined, task: (signal: AbortSignal) => Promise<T>) {
      if (signal?.aborted) throw abortError();
      let shared = pending.get(key) as SharedRequest<T> | undefined;
      if (!shared) {
        const controller = new AbortController();
        shared = { controller, consumers: 0, settled: false, promise: Promise.resolve(undefined as T) };
        shared.promise = task(controller.signal).finally(() => {
          shared!.settled = true;
          pending.delete(key);
        });
        pending.set(key, shared as SharedRequest<unknown>);
      }
      shared.consumers += 1;
      let onAbort: (() => void) | undefined;
      const consumer = signal
        ? Promise.race([
            shared.promise,
            new Promise<never>((_, reject) => {
              onAbort = () => reject(abortError());
              signal.addEventListener("abort", onAbort, { once: true });
            }),
          ])
        : shared.promise;
      try {
        return await consumer;
      } finally {
        if (onAbort) signal?.removeEventListener("abort", onAbort);
        shared.consumers -= 1;
        if (shared.consumers === 0 && !shared.settled) shared.controller.abort();
      }
    },
  };
}

function diagnosticCode(error: unknown): string {
  if (error instanceof TransportError && error.transportCode) return error.transportCode;
  if (error instanceof TransportError && error.status !== undefined) return `HTTP_${error.status}`;
  if (error instanceof TransportError && error.rpcCode !== undefined) return `RPC_${error.rpcCode}`;
  return errorCode(error);
}

function isTransient(error: unknown): boolean {
  if (error instanceof Error && error.name === "AbortError") return false;
  if (!(error instanceof TransportError)) return true;
  if (error.status !== undefined) return error.status === 408 || error.status === 429 || error.status >= 500;
  if (error.rpcCode !== undefined) return error.rpcCode === 429 || error.rpcCode <= -32000;
  const code = diagnosticCode(error).toUpperCase();
  return code.includes("TIMEOUT") || code.includes("NETWORK") || code.includes("TRANSPORT") || code.includes("429");
}

function shouldOpenImmediately(error: unknown): boolean {
  if (!(error instanceof TransportError)) return false;
  return error.status === 408 || error.status === 429 || error.rpcCode === 429
    || diagnosticCode(error).toUpperCase().includes("TIMEOUT");
}

interface Circuit {
  run<T>(task: () => Promise<T>): Promise<T>;
}

function createCircuit(
  source: RuntimeSource,
  registry: ReturnType<typeof createSourceStatusRegistry>,
  options: PassiveCircuitOptions,
): Circuit {
  const threshold = options.failureThreshold ?? 3;
  const cooldownMs = options.cooldownMs ?? 30_000;
  const now = options.now ?? Date.now;
  let probeRunning = false;
  return {
    async run<T>(task: () => Promise<T>): Promise<T> {
      const status = registry.get(source);
      if (status.state === "open") {
        if ((status.retryAt ?? Number.POSITIVE_INFINITY) > now() || probeRunning) {
          throw new TransportError(source === "metadata" ? "ipfs" : source === "rpc" ? "starknet-rpc" : "torii", `${source} circuit is open.`, {
            transportCode: "CIRCUIT_OPEN",
          });
        }
        probeRunning = true;
        registry.update(source, { state: "half-open" });
      }
      try {
        const value = await task();
        registry.update(source, {
          state: "closed",
          consecutiveFailures: 0,
          lastSuccessAt: now(),
          retryAt: undefined,
          lastErrorCode: undefined,
        });
        return value;
      } catch (error) {
        if (isTransient(error)) {
          const current = registry.get(source);
          const failures = current.consecutiveFailures + 1;
          const opened = current.state === "half-open" || shouldOpenImmediately(error) || failures >= threshold;
          registry.update(source, {
            state: opened ? "open" : "closed",
            consecutiveFailures: failures,
            lastFailureAt: now(),
            lastErrorCode: diagnosticCode(error),
            ...(opened ? { retryAt: now() + cooldownMs } : {}),
          });
        }
        throw error;
      } finally {
        probeRunning = false;
      }
    },
  };
}

function requestOptionsWithoutSignal(options?: RequestOptions): RequestOptions {
  return {
    ...(options?.traversal ? { traversal: options.traversal } : {}),
    ...(options?.relicBatchSize === undefined ? {} : { relicBatchSize: options.relicBatchSize }),
    ...(options?.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  };
}

export function createResilientRpcTransport(
  transport: RpcTransport,
  registry: ReturnType<typeof createSourceStatusRegistry>,
  options: PassiveCircuitOptions = {},
): RpcTransport {
  const circuit = createCircuit("rpc", registry, options);
  const coalescer = createRequestCoalescer();
  const run = <T>(key: string, requestOptions: RequestOptions | undefined, task: (signal: AbortSignal) => Promise<TransportResult<T>>) =>
    coalescer.run(key, requestOptions?.signal, (signal) => circuit.run(() => task(signal)));
  return {
    request<T>(method: string, params: readonly unknown[] | Record<string, unknown> = [], requestOptions?: RequestOptions) {
      return run(`request:${method}:${stable(params)}`, requestOptions, (signal) => transport.request<T>(method, params, { ...requestOptionsWithoutSignal(requestOptions), signal }));
    },
    call(input: RpcCall, requestOptions) {
      return run(`call:${stable(input)}`, requestOptions, (signal) => transport.call(input, { ...requestOptionsWithoutSignal(requestOptions), signal }));
    },
    getClassHashAt(address, requestOptions) {
      return run(`class-hash:${address}`, requestOptions, (signal) => transport.getClassHashAt(address, { ...requestOptionsWithoutSignal(requestOptions), signal }));
    },
  };
}

export function createResilientToriiTransport(
  transport: ToriiTransport,
  registry: ReturnType<typeof createSourceStatusRegistry>,
  options: PassiveCircuitOptions = {},
): ToriiTransport {
  const circuit = createCircuit("torii", registry, options);
  const coalescer = createRequestCoalescer();
  const run = <T>(key: string, requestOptions: RequestOptions | undefined, task: (signal: AbortSignal) => Promise<TransportResult<T>>) =>
    coalescer.run(key, requestOptions?.signal, (signal) => circuit.run(() => task(signal)));
  return {
    query<T>(document: string, variables: Record<string, unknown> = {}, requestOptions?: RequestOptions) {
      return run(`query:${document}:${stable(variables)}`, requestOptions, (signal) => transport.query<T>(document, variables, { ...requestOptionsWithoutSignal(requestOptions), signal }));
    },
    model<T>(request: ToriiModelRequest, requestOptions?: RequestOptions) {
      return run(`model:${stable(request)}`, requestOptions, (signal) => transport.model<T>(request, { ...requestOptionsWithoutSignal(requestOptions), signal }));
    },
    events(request = {}, requestOptions) {
      return run(`events:${stable(request)}`, requestOptions, (signal) => transport.events(request, { ...requestOptionsWithoutSignal(requestOptions), signal }));
    },
    tokenBalances(account, request = {}, requestOptions) {
      return run(`token-balances:${account}:${stable(request)}`, requestOptions, (signal) => transport.tokenBalances(account, request, { ...requestOptionsWithoutSignal(requestOptions), signal }));
    },
    tokens(contract, request = {}, requestOptions) {
      return run(`tokens:${contract}:${stable(request)}`, requestOptions, (signal) => transport.tokens(contract, request, { ...requestOptionsWithoutSignal(requestOptions), signal }));
    },
  };
}

export function createResilientMetadataTransport(
  transport: MetadataTransport,
  registry: ReturnType<typeof createSourceStatusRegistry>,
  options: PassiveCircuitOptions = {},
): MetadataTransport {
  const circuit = createCircuit("metadata", registry, options);
  const coalescer = createRequestCoalescer();
  return {
    resolve(uri) { return transport.resolve(uri); },
    getJson<T>(uri: string, requestOptions?: RequestOptions) {
      return coalescer.run(`metadata:${uri}`, requestOptions?.signal, (signal) =>
        circuit.run(() => transport.getJson<T>(uri, { ...requestOptionsWithoutSignal(requestOptions), signal })),
      );
    },
  };
}
