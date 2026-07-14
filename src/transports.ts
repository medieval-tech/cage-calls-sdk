import { errorCode, withTimeout } from "./core.js";
import { normalizeAddress, normalizeFelt, selectorFromName } from "./codecs.js";
import { ConfigurationError, TransportError, UnsupportedCapabilityError, ValidationError } from "./errors.js";
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

export interface AlchemyNft {
  tokenId: bigint;
  contractAddress: Address;
  name?: string;
  description?: string;
  image?: string;
  animationUrl?: string;
  attributes: Array<{ traitType?: string; value?: string | number | boolean | null }>;
}

export interface AlchemyNftTransport {
  supportsContract(contract: Address, options?: RequestOptions): Promise<TransportResult<boolean>>;
  ownedNfts(owner: Address, contract: Address, options?: RequestOptions): Promise<TransportResult<AlchemyNft[]>>;
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
  let id = 0;

  const request = async <T>(
    method: string,
    params: readonly unknown[] | Record<string, unknown> = [],
    requestOptions: RequestOptions = {},
  ): Promise<TransportResult<T>> => {
    const startedAt = Date.now();
    const timeout = withTimeout(requestOptions.signal, timeoutMs);
    try {
      const response = await fetchImpl(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", ...options.headers },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
        signal: timeout.signal,
      });
      if (!response.ok) {
        throw new TransportError("starknet-rpc", `RPC request failed with HTTP ${response.status}.`, { status: response.status });
      }
      const payload = await response.json() as { result?: T; error?: { code?: number; message?: string } };
      if (payload.error) {
        const code = payload.error.code === undefined ? "RPC_ERROR" : `RPC_${payload.error.code}`;
        throw new TransportError("starknet-rpc", `RPC request failed (${code}).`);
      }
      if (!("result" in payload)) throw new TransportError("starknet-rpc", "RPC response did not include a result.");
      return { data: payload.result as T, attempts: [attempt("starknet-rpc", method, startedAt, true)] };
    } catch (cause) {
      const transportError = cause instanceof TransportError
        ? cause
        : new TransportError("starknet-rpc", `RPC request failed (${errorCode(cause)}).`, { cause });
      options.logger?.warn?.("Cage Calls RPC request failed.", { method, errorCode: errorCode(transportError) });
      Object.defineProperty(transportError, "attempts", {
        value: [attempt("starknet-rpc", method, startedAt, false, {
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

export function createFallbackRpcTransport(options: {
  primaryUrl?: string;
  fallbackUrl: string;
  fetch?: typeof fetch;
  headers?: Readonly<Record<string, string>>;
  logger?: SdkLogger;
  timeoutMs?: number;
}): RpcTransport {
  const fallback = createHttpRpcTransport({
    url: options.fallbackUrl,
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.headers ? { headers: options.headers } : {}),
    ...(options.logger ? { logger: options.logger } : {}),
    ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
  });
  const primary = options.primaryUrl
    ? createHttpRpcTransport({
        url: options.primaryUrl,
        ...(options.fetch ? { fetch: options.fetch } : {}),
        ...(options.headers ? { headers: options.headers } : {}),
        ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
      })
    : fallback;

  const request = async <T>(method: string, params?: readonly unknown[] | Record<string, unknown>, requestOptions?: RequestOptions) => {
    try {
      return await primary.request<T>(method, params, requestOptions);
    } catch (primaryError) {
      if (primary === fallback) throw primaryError;
      options.logger?.warn?.("Cage Calls RPC fallback selected.", { method, errorCode: errorCode(primaryError) });
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
      const call = {
        contract_address: normalizeAddress(input.contractAddress),
        entry_point_selector: selectorFromName(input.entrypoint),
        calldata: (input.calldata ?? []).map((value) => normalizeFelt(value)),
      };
      return request<string[]>("starknet_call", [call, input.blockId ?? "latest"], requestOptions);
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
      if (!MODEL_NAME.test(request.model) || request.selection.some((field: string) => !FIELD_NAME.test(field))) {
        throw new ValidationError("Torii model or selection contains an invalid GraphQL identifier.");
      }
      const field = `pm${request.model}Models`;
      const whereType = `pm_${request.model}WhereInput`;
      const orderType = `pm_${request.model}Order`;
      const declarations = ["$first:Int"];
      const argumentsList = ["first:$first"];
      const variables: Record<string, unknown> = { first: request.first ?? 100 };
      if (request.after) {
        declarations.push("$after:Cursor");
        argumentsList.push("after:$after");
        variables.after = request.after;
      }
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
      const document = `query CageCallsModel(${declarations.join(",")}){${field}(${argumentsList.join(",")}){totalCount pageInfo{hasNextPage endCursor} edges{cursor node{${request.selection.join(" ")}}}}}`;
      const result = await query<Record<string, ToriiConnection<T>>>(document, variables, requestOptions);
      const data = result.data[field];
      if (!data) throw new TransportError("torii", `Torii response omitted model ${request.model}.`);
      return { ...result, data };
    },
    async events(request = {}, requestOptions) {
      const document = "query CageCallsEvents($first:Int,$after:Cursor,$keys:[String!]){events(first:$first,after:$after,keys:$keys){totalCount pageInfo{hasNextPage endCursor} edges{cursor node{id keys data executedAt createdAt transactionHash}}}}";
      const variables: Record<string, unknown> = { first: request.first ?? 100 };
      if (request.after) variables.after = request.after;
      if (request.keys) variables.keys = request.keys;
      const result = await query<{ events: ToriiConnection<ToriiRawEvent> }>(document, variables, requestOptions);
      return { ...result, data: result.data.events };
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
      const document = "query CageCallsTokens($contract:String,$offset:Int,$limit:Int){tokens(contractAddress:$contract,offset:$offset,limit:$limit){totalCount edges{node{tokenMetadata{__typename ... on ERC721__Token{tokenId contractAddress metadata metadataName metadataDescription metadataAttributes imagePath} ... on ERC1155__Token{tokenId contractAddress metadata metadataName metadataDescription metadataAttributes imagePath}}}}}}";
      const result = await query<{ tokens: ToriiTokenConnection }>(document, {
        contract: normalizeAddress(contract),
        offset: request.offset ?? 0,
        limit: request.limit ?? 100,
      }, requestOptions);
      return { ...result, data: result.data.tokens };
    },
  };
}

function alchemyBaseUrl(rpcUrl: string): string {
  const rpc = new URL(validateHttpUrl(rpcUrl, "Alchemy RPC URL"));
  if (!rpc.hostname.endsWith(".alchemy.com")) throw new UnsupportedCapabilityError("Alchemy NFT API");
  const apiKey = rpc.pathname.split("/").filter(Boolean).at(-1);
  if (!apiKey || apiKey.startsWith("v0_")) throw new ConfigurationError("Alchemy RPC URL does not contain an API key path segment.");
  return `${rpc.origin}/nft/v3/${encodeURIComponent(apiKey)}`;
}

export function createAlchemyNftTransport(options: { rpcUrl: string; maxPages?: number } & HttpOptions): AlchemyNftTransport {
  const baseUrl = alchemyBaseUrl(options.rpcUrl);
  const fetchImpl = resolveFetch(options.fetch);
  const timeoutMs = options.timeoutMs ?? 12_000;
  const capabilityCache = new Map<Address, boolean>();
  const maxPages = options.maxPages ?? 20;

  const get = async <T>(path: string, parameters: Record<string, string | string[]>, operation: string, requestOptions: RequestOptions = {}) => {
    const startedAt = Date.now();
    const timeout = withTimeout(requestOptions.signal, timeoutMs);
    try {
      const url = new URL(`${baseUrl}/${path}`);
      for (const [name, value] of Object.entries(parameters)) {
        for (const item of Array.isArray(value) ? value : [value]) url.searchParams.append(name, item);
      }
      const response = await fetchImpl(url, { ...(options.headers ? { headers: options.headers } : {}), signal: timeout.signal });
      if (!response.ok) throw new TransportError("alchemy-nft", `Alchemy NFT request failed with HTTP ${response.status}.`, { status: response.status });
      return { data: await response.json() as T, attempts: [attempt("alchemy-nft", operation, startedAt, true)] };
    } catch (cause) {
      const transportError = cause instanceof TransportError
        ? cause
        : new TransportError("alchemy-nft", `Alchemy NFT request failed (${errorCode(cause)}).`, { cause });
      options.logger?.warn?.("Cage Calls Alchemy NFT request failed.", { operation, errorCode: errorCode(transportError) });
      Object.defineProperty(transportError, "attempts", {
        value: [attempt("alchemy-nft", operation, startedAt, false, { errorCode: errorCode(transportError) })],
      });
      throw transportError;
    } finally {
      timeout.cleanup();
    }
  };

  const supportsContract = async (contract: Address, requestOptions?: RequestOptions) => {
    const address = normalizeAddress(contract);
    const cached = capabilityCache.get(address);
    if (cached !== undefined) return { data: cached, attempts: [] };
    const result = await get<Record<string, unknown>>("getContractMetadata", { contractAddress: address }, "contract-probe", requestOptions);
    const tokenType = String(result.data.tokenType ?? (result.data.contract as Record<string, unknown> | undefined)?.tokenType ?? "").toUpperCase();
    const supported = tokenType === "ERC721" || tokenType === "ERC1155";
    capabilityCache.set(address, supported);
    return { ...result, data: supported };
  };

  return {
    supportsContract,
    async ownedNfts(owner, contract, requestOptions) {
      const probe = await supportsContract(contract, requestOptions);
      if (!probe.data) return { data: [], attempts: probe.attempts };
      const items: AlchemyNft[] = [];
      const attempts = [...probe.attempts];
      let pageKey: string | undefined;
      for (let page = 0; page < maxPages; page += 1) {
        const parameters: Record<string, string | string[]> = {
          owner: normalizeAddress(owner),
          "contractAddresses[]": normalizeAddress(contract),
          withMetadata: "true",
          pageSize: "100",
        };
        if (pageKey) parameters.pageKey = pageKey;
        const result = await get<{ ownedNfts?: Array<Record<string, unknown>>; pageKey?: string }>("getNFTsForOwner", parameters, "owned-nfts", requestOptions);
        attempts.push(...result.attempts);
        for (const value of result.data.ownedNfts ?? []) {
          const contractValue = (value.contract as Record<string, unknown> | undefined)?.address;
          if (typeof contractValue !== "string") continue;
          let tokenId: bigint;
          try { tokenId = BigInt(String(value.tokenId)); } catch { continue; }
          const raw = value.raw as Record<string, unknown> | undefined;
          const metadata = raw?.metadata as Record<string, unknown> | undefined;
          const image = value.image as Record<string, unknown> | undefined;
          const attributes = Array.isArray(metadata?.attributes)
            ? metadata.attributes.map((attribute) => {
                const record = attribute as Record<string, unknown>;
                return {
                  ...(typeof record.trait_type === "string" ? { traitType: record.trait_type } : {}),
                  ...(record.value === undefined ? {} : { value: record.value as string | number | boolean | null }),
                };
              })
            : [];
          const item: AlchemyNft = {
            tokenId,
            contractAddress: normalizeAddress(contractValue),
            attributes,
          };
          const name = typeof value.name === "string" ? value.name : typeof metadata?.name === "string" ? metadata.name : undefined;
          const description = typeof value.description === "string" ? value.description : typeof metadata?.description === "string" ? metadata.description : undefined;
          const imageUrl = typeof image?.cachedUrl === "string" ? image.cachedUrl : typeof image?.originalUrl === "string" ? image.originalUrl : typeof metadata?.image === "string" ? metadata.image : undefined;
          const animationUrl = typeof metadata?.animation_url === "string" ? metadata.animation_url : undefined;
          if (name) item.name = name;
          if (description) item.description = description;
          if (imageUrl) item.image = imageUrl;
          if (animationUrl) item.animationUrl = animationUrl;
          items.push(item);
        }
        pageKey = result.data.pageKey || undefined;
        if (!pageKey) return { data: items, attempts };
      }
      return { data: items, attempts };
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
          attempts.push(attempt("ipfs", "metadata", startedAt, false, {
            ...(index > 0 ? { fallback: true } : {}),
            ...(status === undefined ? {} : { status }),
            errorCode: errorCode(cause),
          }));
          options.logger?.warn?.("Cage Calls IPFS gateway failed.", { gatewayIndex: index, errorCode: errorCode(cause) });
          if (requestOptions.signal?.aborted) throw cause;
        } finally {
          timeout.cleanup();
        }
      }
      const error = new TransportError("ipfs", `All ${candidates.length} IPFS gateways failed.`);
      Object.defineProperty(error, "attempts", { value: attempts });
      throw error;
    },
  };
}

export const transportAttemptsFromError = attemptsFromError;
