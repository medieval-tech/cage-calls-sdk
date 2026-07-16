import type { DataSource, SourceAttempt } from "./types.js";

export type CageCallsErrorCode =
  | "CONFIGURATION_ERROR"
  | "VALIDATION_ERROR"
  | "UNSUPPORTED_CAPABILITY"
  | "TRANSPORT_ERROR"
  | "ALL_SOURCES_FAILED"
  | "DECODE_ERROR";

export class CageCallsSdkError extends Error {
  readonly code: CageCallsErrorCode;
  readonly details?: Readonly<Record<string, unknown>>;

  constructor(code: CageCallsErrorCode, message: string, details?: Readonly<Record<string, unknown>>, options?: ErrorOptions) {
    super(message, options);
    this.name = "CageCallsSdkError";
    this.code = code;
    if (details) this.details = details;
  }
}

export class ConfigurationError extends CageCallsSdkError {
  constructor(message: string, details?: Readonly<Record<string, unknown>>) {
    super("CONFIGURATION_ERROR", message, details);
    this.name = "ConfigurationError";
  }
}

export class ValidationError extends CageCallsSdkError {
  constructor(message: string, details?: Readonly<Record<string, unknown>>) {
    super("VALIDATION_ERROR", message, details);
    this.name = "ValidationError";
  }
}

export class UnsupportedCapabilityError extends CageCallsSdkError {
  constructor(capability: string, details?: Readonly<Record<string, unknown>>) {
    super("UNSUPPORTED_CAPABILITY", `Deployment does not support ${capability}.`, { capability, ...details });
    this.name = "UnsupportedCapabilityError";
  }
}

export class TransportError extends CageCallsSdkError {
  readonly source: DataSource;
  readonly status?: number;
  readonly rpcCode?: number;
  readonly transportCode?: string;

  constructor(source: DataSource, message: string, options: { status?: number; rpcCode?: number; transportCode?: string; cause?: unknown } = {}) {
    const details = options.status === undefined && options.rpcCode === undefined && options.transportCode === undefined
      ? undefined
      : {
          ...(options.status === undefined ? {} : { status: options.status }),
          ...(options.rpcCode === undefined ? {} : { rpcCode: options.rpcCode }),
          ...(options.transportCode === undefined ? {} : { transportCode: options.transportCode }),
        };
    super("TRANSPORT_ERROR", message, details, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "TransportError";
    this.source = source;
    if (options.status !== undefined) this.status = options.status;
    if (options.rpcCode !== undefined) this.rpcCode = options.rpcCode;
    if (options.transportCode !== undefined) this.transportCode = options.transportCode;
  }
}

export class AllSourcesFailedError extends CageCallsSdkError {
  readonly attempts: SourceAttempt[];

  constructor(operation: string, attempts: SourceAttempt[]) {
    super("ALL_SOURCES_FAILED", `All configured sources failed for ${operation}.`, { operation, attempts });
    this.name = "AllSourcesFailedError";
    this.attempts = attempts;
  }
}

export class DecodeError extends CageCallsSdkError {
  constructor(message: string, details?: Readonly<Record<string, unknown>>, options?: ErrorOptions) {
    super("DECODE_ERROR", message, details, options);
    this.name = "DecodeError";
  }
}
