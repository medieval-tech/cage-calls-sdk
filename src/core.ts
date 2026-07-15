import { ValidationError } from "./errors.js";
import type { DataResult, DataSource, DataWarning, RequestBudget, RequestOptions, SdkLogger, SourceAttempt } from "./types.js";

export const DEFAULT_REQUEST_BUDGET: Readonly<RequestBudget> = Object.freeze({
  timeoutMs: 12_000,
  maxConcurrency: 5,
  maxRpcPages: 500,
  maxRpcItems: 100_000,
  maxToriiPages: 1_000,
  maxToriiItems: 100_000,
  pageSize: 100,
  relicBatchSize: 100,
});

export function resolveBudget(value?: Partial<RequestBudget>): RequestBudget {
  const budget = { ...DEFAULT_REQUEST_BUDGET, ...value };
  for (const [key, amount] of Object.entries(budget)) {
    if (!Number.isSafeInteger(amount) || amount <= 0) {
      throw new ValidationError(`Budget ${key} must be a positive safe integer.`);
    }
  }
  return budget;
}

export function resolveRequestBudget(budget: RequestBudget, options?: RequestOptions): RequestBudget {
  return resolveBudget({ ...budget, ...options?.traversal, ...(options?.relicBatchSize === undefined ? {} : { relicBatchSize: options.relicBatchSize }) });
}

export function createDataResult<T>(args: {
  data: T;
  source: DataSource;
  complete: boolean;
  attempts: SourceAttempt[];
  warnings?: DataWarning[];
  startedAt: number;
  blockNumber?: bigint;
  now?: () => number;
  logger?: SdkLogger;
}): DataResult<T> {
  const now = args.now?.() ?? Date.now();
  const meta: DataResult<T>["meta"] = {
    source: args.source,
    complete: args.complete,
    attempts: args.attempts,
    warnings: args.warnings ?? [],
    fetchedAt: now,
    durationMs: Math.max(0, now - args.startedAt),
  };
  if (args.blockNumber !== undefined) meta.blockNumber = args.blockNumber;
  const noteworthyAttempts = args.attempts.filter((attempt) => !attempt.ok || attempt.fallback);
  const noteworthy = !args.complete || noteworthyAttempts.length > 0 || meta.warnings.length > 0;
  const logContext = {
    source: args.source,
    complete: args.complete,
    attempts: noteworthyAttempts,
    warningCodes: meta.warnings.map((warning) => warning.code),
    durationMs: meta.durationMs,
  };
  if (noteworthy) args.logger?.warn?.("Cage Calls read used a fallback or returned partial data.", logContext);
  else args.logger?.debug?.("Cage Calls read completed.", logContext);
  return { data: args.data, meta };
}

export function mergeAttempts(...values: ReadonlyArray<ReadonlyArray<SourceAttempt>>): SourceAttempt[] {
  return values.flatMap((value) => value);
}

export async function mapConcurrent<T, R>(
  values: readonly T[],
  concurrency: number,
  mapper: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  const result = new Array<R>(values.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (cursor < values.length) {
      const index = cursor++;
      const value = values[index];
      if (value !== undefined) result[index] = await mapper(value, index);
    }
  });
  await Promise.all(workers);
  return result;
}

export function withTimeout(signal: AbortSignal | undefined, timeoutMs: number): { signal: AbortSignal; cleanup(): void } {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error("Request timed out.")), timeoutMs);
  const abort = () => controller.abort(signal?.reason);
  if (signal?.aborted) abort();
  else signal?.addEventListener("abort", abort, { once: true });
  return {
    signal: controller.signal,
    cleanup() {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
    },
  };
}

export function errorCode(error: unknown): string {
  if (error instanceof Error && "code" in error && typeof error.code === "string") return error.code;
  if (error instanceof DOMException && error.name === "AbortError") return "ABORTED";
  return error instanceof Error ? error.name || "ERROR" : "ERROR";
}
