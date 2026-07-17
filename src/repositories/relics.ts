import { createDataResult, mapConcurrent, resolveRequestBudget } from "../core/request.js";
import { clampPageSize, encodeU256, normalizeAddress, sameAddress } from "../core/codecs.js";
import {
  decodeByteArrayRpc,
  decodeOwnedRelicPageRpc,
  decodeRelicDataRpc,
  decodeRelicRowsRpc,
  decodeSingleU256,
} from "../core/decoders.js";
import { AllSourcesFailedError, TransportError, UnsupportedCapabilityError, ValidationError } from "../core/errors.js";
import { createFightersRepository, type RepositoryContext } from "./index.js";
import { summarizeRelicCollection, type RelicCollectionStats, type RelicStatsFilter } from "./relic-stats.js";
import type {
  MetadataTransport,
  ToriiTokenNode,
} from "../transports/index.js";
import { transportAttemptsFromError } from "../transports/index.js";
import type {
  Address,
  DataResult,
  DataSource,
  DataWarning,
  Fighter,
  Page,
  Relic,
  RelicMetadataAttribute,
  RelicOwnershipProvenance,
  RequestOptions,
  SourceAttempt,
} from "../core/types.js";

interface RelicContext extends RepositoryContext {
  metadata?: MetadataTransport;
}

export interface OwnedRelicsPage extends Page<Relic> {
  provenance: RelicOwnershipProvenance;
}

export interface RelicFeedInput {
  limit?: number;
  cursor?: bigint;
}

export interface RelicCollectionInput {
  pageSize?: number;
  enrichFighters?: boolean;
}

export interface RelicCollection {
  items: Relic[];
  fighters: Fighter[];
  scannedCount: number;
  pageCount: number;
}

export interface RelicsRepository {
  get(tokenId: bigint, options?: RequestOptions): Promise<DataResult<Relic>>;
  getMany(tokenIds: readonly bigint[], options?: RequestOptions): Promise<DataResult<Relic[]>>;
  all(input?: RelicCollectionInput, options?: RequestOptions): Promise<DataResult<Relic[]>>;
  page(input?: RelicFeedInput, options?: RequestOptions): Promise<DataResult<Page<Relic, bigint>>>;
  /** @deprecated Use page(). */
  feed(input?: RelicFeedInput, options?: RequestOptions): Promise<DataResult<Page<Relic, bigint>>>;
  /** Exhaustive structured inventory. Does not fetch external token JSON or media. */
  inventory(input?: RelicCollectionInput, options?: RequestOptions): Promise<DataResult<RelicCollection>>;
  collection(input?: RelicCollectionInput, options?: RequestOptions): Promise<DataResult<RelicCollection>>;
  stats(filter?: RelicStatsFilter, options?: RequestOptions): Promise<DataResult<RelicCollectionStats>>;
  /** Owned inventory without external token JSON or media hydration. */
  ownedInventory(owner: Address, options?: RequestOptions): Promise<DataResult<OwnedRelicsPage>>;
  owned(owner: Address, options?: RequestOptions): Promise<DataResult<OwnedRelicsPage>>;
  metadata(tokenId: bigint, options?: RequestOptions): Promise<DataResult<Relic>>;
  owner(tokenId: bigint, options?: RequestOptions): Promise<DataResult<Address>>;
}

type DecodedRelicFeedCursor =
  | { kind: "start" }
  | { kind: "legacy-torii"; offset: number }
  | { kind: "torii"; offset: number; tokenRows: number; rpcCursor: bigint }
  | { kind: "rpc"; rpcCursor: bigint };

function encodeOpaqueRelicFeedCursor(value: string): bigint {
  let encoded = 0n;
  for (let index = 0; index < value.length; index += 1) {
    const byte = value.charCodeAt(index);
    if (byte > 0x7f) throw new ValidationError("Relic feed cursor contains unsupported characters.");
    encoded = (encoded << 8n) | BigInt(byte);
  }
  return -(encoded + 1n);
}

function decodeOpaqueRelicFeedCursor(cursor: bigint): string {
  let encoded = -cursor - 1n;
  const bytes: number[] = [];
  while (encoded > 0n) {
    bytes.unshift(Number(encoded & 0xffn));
    encoded >>= 8n;
  }
  return String.fromCharCode(...bytes);
}

function toriiFeedCursor(offset: number, tokenRows: number, rpcCursor: bigint): bigint {
  return encodeOpaqueRelicFeedCursor(`t|${offset}|${tokenRows}|${rpcCursor}`);
}

function rpcFeedCursor(rpcCursor: bigint): bigint {
  return encodeOpaqueRelicFeedCursor(`r|${rpcCursor}`);
}

function decodeFeedCursor(cursor: bigint | undefined): DecodedRelicFeedCursor {
  if (cursor === undefined || cursor === 0n) return { kind: "start" };
  if (cursor > 0n) {
    const offset = Number(cursor);
    if (!Number.isSafeInteger(offset)) throw new ValidationError("Relic feed cursor is too large.");
    return { kind: "legacy-torii", offset };
  }

  const decoded = decodeOpaqueRelicFeedCursor(cursor);
  const parts = decoded.split("|");
  try {
    if (parts[0] === "t" && parts.length === 4) {
      const offset = Number(parts[1]);
      const tokenRows = Number(parts[2]);
      if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(tokenRows) || tokenRows < offset) {
        throw new Error("invalid offset");
      }
      return { kind: "torii", offset, tokenRows, rpcCursor: BigInt(parts[3] ?? "") };
    }
    if (parts[0] === "r" && parts.length === 2) {
      return { kind: "rpc", rpcCursor: BigInt(parts[1] ?? "") };
    }
  } catch {
    // Fall through to the stable validation error below.
  }
  throw new ValidationError("Relic feed cursor is invalid.");
}

function parseAttributes(value: unknown): RelicMetadataAttribute[] {
  const source = typeof value === "string" ? (() => { try { return JSON.parse(value) as unknown; } catch { return []; } })() : value;
  if (!Array.isArray(source)) return [];
  return source.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const record = item as Record<string, unknown>;
    const attribute: RelicMetadataAttribute = {};
    const trait = record.trait_type ?? record.traitType;
    if (typeof trait === "string") attribute.traitType = trait;
    const value = record.value;
    if (value === null || ["string", "number", "boolean"].includes(typeof value)) {
      attribute.value = value as string | number | boolean | null;
    }
    return [attribute];
  });
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function mapToriiRelic(token: ToriiTokenNode, relicAddress: Address): Relic | undefined {
  if (token.__typename !== "ERC721__Token" || !token.contractAddress || !sameAddress(token.contractAddress, relicAddress) || !token.tokenId) return undefined;
  let tokenId: bigint;
  try { tokenId = BigInt(token.tokenId); } catch { return undefined; }
  let metadata: Record<string, unknown> | undefined;
  if (token.metadata) {
    try {
      const parsed = JSON.parse(token.metadata) as unknown;
      if (parsed && typeof parsed === "object") metadata = parsed as Record<string, unknown>;
    } catch {
      // Individual malformed metadata is a partial row, not an ownership failure.
    }
  }
  const attributes = parseAttributes(token.metadataAttributes);
  const fallbackAttributes = parseAttributes(metadata?.attributes);
  const relic: Relic = {
    tokenId,
    attributes: attributes.length > 0 ? attributes : fallbackAttributes,
    metadataSources: ["torii"],
  };
  const name = stringValue(token.metadataName) ?? stringValue(metadata?.name);
  const description = stringValue(token.metadataDescription) ?? stringValue(metadata?.description);
  const image = stringValue(metadata?.image) ?? stringValue(token.imagePath);
  const animationUrl = stringValue(metadata?.animation_url);
  if (name) relic.name = name;
  if (description) relic.description = description;
  if (image) relic.image = image;
  if (animationUrl) relic.animationUrl = animationUrl;
  return relic;
}

function mergeRelic(current: Relic | undefined, incoming: Relic): Relic {
  const merged: Relic = {
    ...current,
    ...incoming,
    tokenId: incoming.tokenId,
    attributes: incoming.attributes.length > 0 ? incoming.attributes : current?.attributes ?? [],
    metadataSources: Array.from(new Set([...(current?.metadataSources ?? []), ...(incoming.metadataSources ?? [])])),
  };
  return merged;
}

function metadataComplete(relic: Relic): boolean {
  return Boolean(relic.name && (relic.image || relic.animationUrl) && relic.attributes.length > 0);
}

function onchainAttributes(relic: Relic): RelicMetadataAttribute[] {
  const metadata = relic.metadata;
  if (!metadata) return [];
  return [
    { traitType: "Rarity", value: metadata.rarity },
    { traitType: "Relic Type", value: metadata.relicType },
    { traitType: "Move Name", value: metadata.moveName },
    { traitType: "Power", value: metadata.power },
    { traitType: "Speed", value: metadata.speed },
  ];
}

function fromJson(relic: Relic, value: unknown, metadataTransport?: MetadataTransport): Relic {
  if (!value || typeof value !== "object") return relic;
  const record = value as Record<string, unknown>;
  const merged = { ...relic };
  const name = stringValue(record.name);
  const description = stringValue(record.description);
  const image = stringValue(record.image);
  const animationUrl = stringValue(record.animation_url);
  const attributes = parseAttributes(record.attributes);
  if (name) merged.name = name;
  if (description) merged.description = description;
  if (image) merged.image = metadataTransport?.resolve(image) ?? image;
  if (animationUrl) merged.animationUrl = metadataTransport?.resolve(animationUrl) ?? animationUrl;
  if (attributes.length > 0) merged.attributes = attributes;
  merged.metadataSources = Array.from(new Set([...(merged.metadataSources ?? []), "ipfs" as const]));
  return merged;
}

function toResult<T>(
  context: RelicContext,
  startedAt: number,
  source: DataSource,
  data: T,
  attempts: SourceAttempt[],
  complete: boolean,
  warnings: DataWarning[] = [],
): DataResult<T> {
  return createDataResult({
    data, source, complete, attempts, warnings, startedAt, now: context.now,
    ...(context.logger ? { logger: context.logger } : {}),
  });
}

async function rpcCall(context: RelicContext, entrypoint: string, calldata: string[], options: RequestOptions) {
  return context.rpc.call({ contractAddress: context.network.contracts.RelicNFT, entrypoint, calldata }, options);
}

async function hydrateJson(context: RelicContext, relic: Relic, attempts: SourceAttempt[], warnings: DataWarning[], options: RequestOptions): Promise<Relic> {
  if (!context.metadata || !relic.tokenUri) {
    const attributes = relic.attributes.length > 0 ? relic.attributes : onchainAttributes(relic);
    return { ...relic, attributes };
  }
  try {
    const response = await context.metadata.getJson(relic.tokenUri, options);
    attempts.push(...response.attempts);
    return fromJson(relic, response.data, context.metadata);
  } catch (error) {
    attempts.push(...transportAttemptsFromError(error));
    warnings.push({
      code: "METADATA_UNAVAILABLE",
      message: `Metadata for relic ${relic.tokenId} could not be hydrated.`,
      source: "ipfs",
    });
    return { ...relic, attributes: relic.attributes.length > 0 ? relic.attributes : onchainAttributes(relic) };
  }
}

export function createRelicsRepository(context: RelicContext): RelicsRepository {
  let detectedRelicBatchLimit: number | undefined;

  const getStructured = async (tokenId: bigint, options: RequestOptions = {}) => {
    if (tokenId <= 0n) throw new ValidationError("tokenId must be greater than zero.");
    const attempts: SourceAttempt[] = [];
    try {
      const id = encodeU256(tokenId);
      const [owner, data, eventName, tokenUri] = await Promise.all([
        rpcCall(context, "owner_of", id, options),
        rpcCall(context, "relic_data", id, options),
        rpcCall(context, "relic_event_name", id, options),
        rpcCall(context, "get_token_uri", id, options),
      ]);
      attempts.push(...owner.attempts, ...data.attempts, ...eventName.attempts, ...tokenUri.attempts);
      const ownerAddress = owner.data[0];
      if (!ownerAddress) throw new ValidationError("Relic owner response was empty.");
      const relicData = decodeRelicDataRpc(data.data);
      const relic: Relic = {
        tokenId,
        owner: normalizeAddress(ownerAddress),
        ...relicData,
        eventName: decodeByteArrayRpc(eventName.data, "relicEventName"),
        tokenUri: decodeByteArrayRpc(tokenUri.data, "relicTokenUri"),
        name: relicData.metadata.moveName || `Relic #${tokenId}`,
        attributes: [],
        ownershipSource: "starknet-rpc",
        metadataSources: ["starknet-rpc"],
      };
      return { relic, attempts };
    } catch (error) {
      attempts.push(...transportAttemptsFromError(error));
      throw new AllSourcesFailedError("relics.get-structured", attempts);
    }
  };

  const get = async (tokenId: bigint, options: RequestOptions = {}) => {
    const startedAt = context.now();
    const warnings: DataWarning[] = [];
    const structured = await getStructured(tokenId, options);
    const relic = await hydrateJson(context, structured.relic, structured.attempts, warnings, options);
    return toResult(context, startedAt, "starknet-rpc", relic, structured.attempts, metadataComplete(relic), warnings);
  };

  function rateLimited(error: unknown): boolean {
    if (error instanceof TransportError) return error.status === 429 || error.rpcCode === 429;
    if (error instanceof AllSourcesFailedError) {
      return error.attempts.some((attempt) => attempt.status === 429 || attempt.errorCode?.includes("429"));
    }
    return false;
  }

  async function relicBatchLimit(
    attempts: SourceAttempt[],
    warnings: DataWarning[],
    options: RequestOptions,
  ): Promise<number> {
    if (detectedRelicBatchLimit !== undefined) return detectedRelicBatchLimit;
    try {
      const response = await rpcCall(context, "max_relic_batch_size", [], options);
      attempts.push(...response.attempts);
      const raw = response.data[0];
      const advertised = raw === undefined ? 20 : Number(BigInt(raw));
      detectedRelicBatchLimit = Number.isSafeInteger(advertised) && advertised >= 0 ? advertised : 20;
    } catch (error) {
      attempts.push(...transportAttemptsFromError(error));
      if (options.signal?.aborted) throw error;
      detectedRelicBatchLimit = 20;
      warnings.push({
        code: "LEGACY_RELIC_BATCH_LIMIT",
        message: "This RelicNFT deployment does not advertise its aggregate limit; batches are limited to 20 for compatibility.",
        source: "starknet-rpc",
      });
    }
    return detectedRelicBatchLimit;
  }

  const getManyStructured = async (tokenIds: readonly bigint[], options: RequestOptions = {}) => {
    const startedAt = context.now();
    const unique = Array.from(new Set(tokenIds));
    if (unique.length === 0) return toResult(context, startedAt, "derived", [], [], true);
    if (unique.some((tokenId) => tokenId <= 0n)) throw new ValidationError("tokenIds must be greater than zero.");
    const supportsBatch = context.capabilities.has("relicBatch") || await context.capabilities.probe("relicBatch", options.signal);
    if (!supportsBatch) {
      const values = await mapConcurrent(unique, context.budget.maxConcurrency, (tokenId) => getStructured(tokenId, options));
      return toResult(
        context,
        startedAt,
        "starknet-rpc",
        values.map((value) => value.relic),
        values.flatMap((value) => value.attempts),
        true,
      );
    }

    const attempts: SourceAttempt[] = [];
    const warnings: DataWarning[] = [];
    const budget = resolveRequestBudget(context.budget, options);
    const contractLimit = await relicBatchLimit(attempts, warnings, options);
    const batchSize = contractLimit === 0
      ? budget.relicBatchSize
      : Math.min(budget.relicBatchSize, contractLimit);
    const chunks: bigint[][] = [];
    for (let index = 0; index < unique.length; index += batchSize) chunks.push(unique.slice(index, index + batchSize));

    const fetchBatch = async (chunk: readonly bigint[]): Promise<Relic[]> => {
      try {
        const response = await rpcCall(context, "get_relics", [chunk.length.toString(), ...chunk.flatMap((tokenId) => encodeU256(tokenId))], options);
        attempts.push(...response.attempts);
        return decodeRelicRowsRpc(response.data);
      } catch (error) {
        attempts.push(...transportAttemptsFromError(error));
        if (options.signal?.aborted || rateLimited(error) || chunk.length <= 1) throw error;
        const midpoint = Math.ceil(chunk.length / 2);
        warnings.push({
          code: "RELIC_BATCH_SPLIT",
          message: `A ${chunk.length}-relic aggregate call failed and was retried as smaller batches.`,
          source: "starknet-rpc",
        });
        // Run halves in sequence so a successful smaller call closes the passive
        // RPC circuit before probing the sibling at the same size.
        const left = await fetchBatch(chunk.slice(0, midpoint));
        const right = await fetchBatch(chunk.slice(midpoint));
        return [...left, ...right];
      }
    };

    const relics = (await mapConcurrent(chunks, budget.maxConcurrency, fetchBatch)).flat();
    const present = new Set(relics.map((row) => row.tokenId));
    const missing = unique.filter((tokenId) => !present.has(tokenId));
    if (missing.length > 0) {
      warnings.push({ code: "MISSING_RELICS", message: `${missing.length} requested relic(s) were not returned.` });
    }
    return toResult(context, startedAt, "starknet-rpc", relics, attempts, relics.length === unique.length, warnings);
  };

  const getMany = async (tokenIds: readonly bigint[], options: RequestOptions = {}) => {
    const startedAt = context.now();
    const structured = await getManyStructured(tokenIds, options);
    const attempts = [...structured.meta.attempts];
    const warnings = [...structured.meta.warnings];
    const relics = await mapConcurrent(
      structured.data,
      resolveRequestBudget(context.budget, options).maxConcurrency,
      (relic) => hydrateJson(context, relic, attempts, warnings, options),
    );
    return toResult(context, startedAt, "starknet-rpc", relics, attempts, structured.meta.complete && relics.every(metadataComplete), warnings);
  };

  async function toriiOwned(
    owner: Address,
    attempts: SourceAttempt[],
    warnings: DataWarning[],
    options: RequestOptions,
  ): Promise<{ relics: Relic[]; complete: boolean }> {
    if (!context.torii) return { relics: [], complete: false };
    const budget = resolveRequestBudget(context.budget, options);
    const relics = new Map<string, Relic>();
    let offset = 0;
    let complete = false;
    let pages = 0;
    for (; pages < budget.maxToriiPages && relics.size < budget.maxToriiItems; pages += 1) {
      const response = await context.torii.tokenBalances(owner, { offset, limit: budget.pageSize }, options);
      attempts.push(...response.attempts);
      for (const edge of response.data.edges) {
        const mapped = edge.node.tokenMetadata ? mapToriiRelic(edge.node.tokenMetadata, context.network.contracts.RelicNFT) : undefined;
        if (mapped && relics.size < budget.maxToriiItems) relics.set(mapped.tokenId.toString(), mapped);
      }
      offset += response.data.edges.length;
      if (response.data.edges.length === 0 || offset >= response.data.totalCount) {
        complete = true;
        break;
      }
    }
    if (!complete) {
      const itemLimit = relics.size >= budget.maxToriiItems;
      warnings.push({
        code: itemLimit ? "TORII_ITEM_LIMIT" : "TORII_PAGE_LIMIT",
        message: itemLimit
          ? `Relic ownership enumeration reached the ${budget.maxToriiItems} item budget at offset ${offset}.`
          : `Relic ownership enumeration reached the ${budget.maxToriiPages} page budget at offset ${offset}.`,
        source: "torii",
      });
    }
    return { relics: Array.from(relics.values()), complete };
  }

  async function rpcOwned(
    owner: Address,
    expectedBalance: bigint,
    attempts: SourceAttempt[],
    warnings: DataWarning[],
    options: RequestOptions,
    hydrateExternal: boolean,
  ): Promise<{ relics: Relic[]; complete: boolean }> {
    const budget = resolveRequestBudget(context.budget, options);
    const ownerPage = context.capabilities.has("relicOwnerPage") || await context.capabilities.probe("relicOwnerPage", options.signal);
    if (ownerPage) {
      const relics = new Map<string, Relic>();
      let cursor = 0n;
      let complete = false;
      let pages = 0;
      const seen = new Set<bigint>();
      for (; pages < budget.maxRpcPages && relics.size < budget.maxRpcItems; pages += 1) {
        const previousCursor = cursor;
        const response = await rpcCall(context, "get_owned_relics", [normalizeAddress(owner), ...encodeU256(cursor), "200", "20"], options);
        attempts.push(...response.attempts);
        const decoded = decodeOwnedRelicPageRpc(response.data);
        for (const relic of decoded.items) relics.set(relic.tokenId.toString(), relic);
        cursor = decoded.cursor;
        if (BigInt(relics.size) >= expectedBalance) {
          complete = true;
          break;
        }
        if (cursor === 0n) {
          complete = true;
          break;
        }
        if (cursor === previousCursor || seen.has(cursor)) {
          warnings.push({
            code: "RPC_CURSOR_STALLED",
            message: `Relic owner pagination stopped at repeated cursor ${cursor}.`,
            source: "starknet-rpc",
          });
          break;
        }
        seen.add(cursor);
      }
      if (!complete && !warnings.some((warning) => warning.code === "RPC_CURSOR_STALLED")) {
        const itemLimit = relics.size >= budget.maxRpcItems;
        warnings.push({
          code: itemLimit ? "RPC_ITEM_LIMIT" : "RPC_PAGE_LIMIT",
          message: itemLimit
            ? `Relic owner pagination reached the ${budget.maxRpcItems} item budget at cursor ${cursor}.`
            : `Relic owner pagination reached the ${budget.maxRpcPages} page budget after scanning up to ${budget.maxRpcPages * 200} token IDs; next cursor ${cursor}.`,
          source: "starknet-rpc",
        });
      }
      const hydrated = hydrateExternal
        ? await mapConcurrent(Array.from(relics.values()), context.budget.maxConcurrency, (relic) => hydrateJson(context, relic, attempts, warnings, options))
        : Array.from(relics.values());
      return { relics: hydrated, complete };
    }

    const relicFeed = context.capabilities.has("relicFeed") || await context.capabilities.probe("relicFeed", options.signal);
    if (relicFeed) {
      const relics = new Map<string, Relic>();
      let cursor = 0n;
      let complete = false;
      let pages = 0;
      const seen = new Set<bigint>();
      for (; pages < budget.maxRpcPages && relics.size < budget.maxRpcItems; pages += 1) {
        const previousCursor = cursor;
        const response = await rpcCall(context, "get_relic_feed", [...encodeU256(cursor), "20"], options);
        attempts.push(...response.attempts);
        const rows = decodeRelicRowsRpc(response.data);
        for (const relic of rows) if (relic.owner && sameAddress(relic.owner, owner)) relics.set(relic.tokenId.toString(), relic);
        if (BigInt(relics.size) >= expectedBalance) {
          complete = true;
          break;
        }
        const oldest = rows.at(-1)?.tokenId ?? 0n;
        if (rows.length < 20 || oldest <= 1n) {
          complete = true;
          break;
        }
        cursor = oldest - 1n;
        if (cursor === previousCursor || seen.has(cursor)) {
          warnings.push({ code: "RPC_CURSOR_STALLED", message: `Legacy relic pagination stopped at repeated cursor ${cursor}.`, source: "starknet-rpc" });
          break;
        }
        seen.add(cursor);
      }
      warnings.push({ code: "LEGACY_RELIC_SCAN", message: "Ownership used exhaustive legacy relic feed scanning within the configured RPC budget.", source: "starknet-rpc" });
      if (!complete && !warnings.some((warning) => warning.code === "RPC_CURSOR_STALLED")) {
        const itemLimit = relics.size >= budget.maxRpcItems;
        warnings.push({
          code: itemLimit ? "RPC_ITEM_LIMIT" : "RPC_PAGE_LIMIT",
          message: itemLimit
            ? `Legacy relic ownership reached the ${budget.maxRpcItems} item budget at cursor ${cursor}.`
            : `Legacy relic ownership reached the ${budget.maxRpcPages} page budget; next cursor ${cursor}.`,
          source: "starknet-rpc",
        });
      }
      const hydrated = hydrateExternal
        ? await mapConcurrent(Array.from(relics.values()), context.budget.maxConcurrency, (relic) => hydrateJson(context, relic, attempts, warnings, options))
        : Array.from(relics.values());
      return { relics: hydrated, complete };
    }

    throw new UnsupportedCapabilityError("bounded relic ownership fallback");
  }

  async function loadInventory(
    input: RelicCollectionInput = {},
    options: RequestOptions = {},
  ): Promise<DataResult<RelicCollection>> {
    const startedAt = context.now();
    const budget = resolveRequestBudget(context.budget, options);
    const pageSize = clampPageSize(input.pageSize, 200, Math.min(200, budget.pageSize));
    const attempts: SourceAttempt[] = [];
    const warnings: DataWarning[] = [];
    const relics = new Map<string, Relic>();
    let pageCount = 0;
    let toriiComplete = false;
    let source: DataSource = context.torii ? "torii" : "starknet-rpc";

    if (context.torii) {
      let offset = 0;
      try {
        for (let page = 0; page < budget.maxToriiPages && relics.size < budget.maxToriiItems; page += 1) {
          pageCount += 1;
          const response = await context.torii.tokens(
            context.network.contracts.RelicNFT,
            { offset, limit: pageSize },
            options,
          );
          attempts.push(...response.attempts);
          for (const edge of response.data.edges) {
            const mapped = edge.node.tokenMetadata
              ? mapToriiRelic(edge.node.tokenMetadata, context.network.contracts.RelicNFT)
              : undefined;
            if (mapped && relics.size < budget.maxToriiItems) relics.set(mapped.tokenId.toString(), mapped);
          }
          offset += response.data.edges.length;
          const tokenRows = Math.max(0, response.data.totalCount - 1);
          if (offset >= tokenRows || response.data.edges.length === 0) {
            toriiComplete = offset >= tokenRows;
            break;
          }
        }
        if (!toriiComplete) {
          warnings.push({
            code: relics.size >= budget.maxToriiItems ? "TORII_ITEM_LIMIT" : "TORII_PAGE_LIMIT",
            message: relics.size >= budget.maxToriiItems
              ? `Relic inventory reached the ${budget.maxToriiItems} Torii item budget.`
              : `Relic inventory reached the ${budget.maxToriiPages} Torii page budget.`,
            source: "torii",
          });
        }
      } catch (error) {
        attempts.push(...transportAttemptsFromError(error));
        warnings.push({ code: "TORII_UNAVAILABLE", message: "Torii relic inventory lookup failed.", source: "torii" });
        toriiComplete = false;
      }
    }

    const toriiUnavailable = warnings.some((warning) => warning.code === "TORII_UNAVAILABLE");
    if (context.torii && !toriiUnavailable) {
      const fighters: Fighter[] = [];
      let fightersComplete = input.enrichFighters === false;
      if (input.enrichFighters !== false) {
        try {
          const response = await createFightersRepository(context).all({}, options);
          attempts.push(...response.meta.attempts);
          warnings.push(...response.meta.warnings);
          fighters.push(...response.data.sort((a, b) => a.name.localeCompare(b.name)));
          fightersComplete = response.meta.complete;
        } catch (error) {
          attempts.push(...transportAttemptsFromError(error));
          warnings.push({ code: "TORII_FIGHTER_ENRICHMENT_FAILED", message: "Fighter names could not be enumerated through Torii.", source: "torii" });
        }
      }
      const items = Array.from(relics.values()).sort((a, b) => a.tokenId === b.tokenId ? 0 : a.tokenId > b.tokenId ? -1 : 1);
      const metadataComplete = items.every((relic) => relic.metadata || relic.attributes.length > 0);
      if (!metadataComplete) {
        warnings.push({
          code: "TORII_METADATA_INCOMPLETE",
          message: "Torii returned one or more relics without indexed attribute metadata.",
          source: "torii",
        });
      }
      return toResult(
        context,
        startedAt,
        "torii",
        { items, fighters, scannedCount: items.length, pageCount },
        attempts,
        toriiComplete && fightersComplete && metadataComplete,
        warnings,
      );
    }

    let expectedIds: bigint[] | undefined;
    try {
      const response = await rpcCall(context, "next_token_id", [], options);
      attempts.push(...response.attempts);
      const nextTokenId = decodeSingleU256(response.data, "nextRelicTokenId");
      const expectedCount = nextTokenId > 0n ? nextTokenId - 1n : 0n;
      const boundedCount = expectedCount > BigInt(budget.maxRpcItems)
        ? budget.maxRpcItems
        : Number(expectedCount);
      expectedIds = Array.from({ length: boundedCount }, (_, index) => BigInt(index + 1));
      if (expectedCount > BigInt(budget.maxRpcItems)) {
        warnings.push({
          code: "RPC_ITEM_LIMIT",
          message: `Relic inventory expected ${expectedCount} tokens and was bounded by the ${budget.maxRpcItems} RPC item budget.`,
          source: "starknet-rpc",
        });
      }
    } catch (error) {
      attempts.push(...transportAttemptsFromError(error));
      warnings.push({
        code: "RELIC_SUPPLY_UNAVAILABLE",
        message: "The RelicNFT supply cursor could not be read; Torii inventory freshness could not be verified.",
        source: "starknet-rpc",
      });
    }

    let legacyComplete = false;
    if (expectedIds === undefined && relics.size === 0) {
      const relicFeed = context.capabilities.has("relicFeed") || await context.capabilities.probe("relicFeed", options.signal);
      if (relicFeed) {
        source = "starknet-rpc";
        let cursor = 0n;
        const rpcPageSize = Math.min(20, pageSize);
        for (let page = 0; page < budget.maxRpcPages && relics.size < budget.maxRpcItems; page += 1) {
          const response = await rpcCall(context, "get_relic_feed", [...encodeU256(cursor), rpcPageSize.toString()], options);
          attempts.push(...response.attempts);
          pageCount += 1;
          const rows = decodeRelicRowsRpc(response.data);
          for (const relic of rows) relics.set(relic.tokenId.toString(), relic);
          const oldest = rows.at(-1)?.tokenId ?? 0n;
          if (rows.length < rpcPageSize || oldest <= 1n) {
            legacyComplete = true;
            break;
          }
          cursor = oldest - 1n;
        }
        warnings.push({
          code: "LEGACY_RELIC_SCAN",
          message: "Relic inventory used the cursor feed because the supply cursor was unavailable.",
          source: "starknet-rpc",
        });
      }
    }

    const missing = expectedIds?.filter((tokenId) => !relics.has(tokenId.toString())) ?? [];
    const incomplete = Array.from(relics.values())
      .filter((relic) => !relic.metadata && relic.attributes.length === 0)
      .map((relic) => relic.tokenId);
    const rpcIds = Array.from(new Set([...missing, ...incomplete]));
    let rpcComplete = rpcIds.length === 0;
    if (rpcIds.length > 0) {
      try {
        const response = await getManyStructured(rpcIds, options);
        attempts.push(...response.meta.attempts);
        warnings.push(...response.meta.warnings);
        for (const relic of response.data) {
          relics.set(relic.tokenId.toString(), mergeRelic(relics.get(relic.tokenId.toString()), relic));
        }
        rpcComplete = response.meta.complete;
        source = "starknet-rpc";
      } catch (error) {
        attempts.push(...transportAttemptsFromError(error));
        warnings.push({
          code: "RELIC_GAP_FILL_FAILED",
          message: `${rpcIds.length} missing or incomplete Torii relic rows could not be filled through aggregate RPC.`,
          source: "starknet-rpc",
        });
      }
    }

    const fighters: Fighter[] = [];
    let fightersComplete = input.enrichFighters === false;
    if (input.enrichFighters !== false && context.torii) {
      try {
        const response = await createFightersRepository(context).all({}, options);
        attempts.push(...response.meta.attempts);
        warnings.push(...response.meta.warnings);
        fighters.push(...response.data.sort((a, b) => a.name.localeCompare(b.name)));
        fightersComplete = response.meta.complete;
      } catch (error) {
        attempts.push(...transportAttemptsFromError(error));
        warnings.push({ code: "TORII_FIGHTER_ENRICHMENT_FAILED", message: "Fighter names could not be enumerated through Torii.", source: "torii" });
      }
    } else if (!context.torii) {
      fightersComplete = input.enrichFighters === false;
    }

    const items = Array.from(relics.values()).sort((a, b) => a.tokenId === b.tokenId ? 0 : a.tokenId > b.tokenId ? -1 : 1);
    const expectedComplete = expectedIds !== undefined
      && !warnings.some((warning) => warning.code === "RPC_ITEM_LIMIT")
      && items.length === expectedIds.length;
    const complete = expectedIds === undefined
      ? (toriiComplete || legacyComplete) && fightersComplete
      : expectedComplete && rpcComplete && fightersComplete;
    return toResult(
      context,
      startedAt,
      source,
      { items, fighters, scannedCount: items.length, pageCount },
      attempts,
      complete,
      warnings,
    );
  }

  async function loadOwned(
    ownerInput: Address,
    options: RequestOptions,
    hydrateExternal: boolean,
  ): Promise<DataResult<OwnedRelicsPage>> {
    const owner = normalizeAddress(ownerInput);
    const startedAt = context.now();
    const attempts: SourceAttempt[] = [];
    const warnings: DataWarning[] = [];
    let toriiInventory: { relics: Relic[]; complete: boolean } = { relics: [], complete: false };
    if (context.torii) {
      try {
        toriiInventory = await toriiOwned(owner, attempts, warnings, options);
        const torii = hydrateExternal
          ? await mapConcurrent(
              toriiInventory.relics,
              resolveRequestBudget(context.budget, options).maxConcurrency,
              (relic) => hydrateJson(context, relic, attempts, warnings, options),
            )
          : toriiInventory.relics;
        const metadataVerified = !hydrateExternal || torii.every(metadataComplete);
        if (!metadataVerified) {
          warnings.push({
            code: "TORII_METADATA_INCOMPLETE",
            message: "Torii returned one or more owned relics without complete media metadata.",
            source: "torii",
          });
        }
        return toResult(context, startedAt, "torii", {
          items: torii.map((relic) => ({ ...relic, owner, ownershipSource: "torii" as const })),
          hasMore: !toriiInventory.complete,
          provenance: { owner, onchainBalance: BigInt(torii.length), ownershipSource: "torii", verified: toriiInventory.complete },
        }, attempts, toriiInventory.complete && metadataVerified, warnings);
      } catch (error) {
        attempts.push(...transportAttemptsFromError(error));
        warnings.push({ code: "TORII_UNAVAILABLE", message: "Torii ownership lookup failed.", source: "torii" });
      }
    }

    let balance: bigint;
    try {
      const response = await rpcCall(context, "balance_of", [owner], options);
      attempts.push(...response.attempts);
      balance = decodeSingleU256(response.data, "relicBalance");
    } catch (error) {
      attempts.push(...transportAttemptsFromError(error));
      throw new AllSourcesFailedError("relics.owned.balance-verification", attempts);
    }

    if (balance === 0n) {
      return toResult(context, startedAt, "starknet-rpc", {
        items: [],
        hasMore: false,
        provenance: { owner, onchainBalance: 0n, ownershipSource: "starknet-rpc", verified: true },
      }, attempts, true, warnings);
    }

    try {
      const discovered = await rpcOwned(owner, balance, attempts, warnings, options, hydrateExternal);
      const verified = BigInt(discovered.relics.length) === balance;
      if (discovered.relics.length === 0 && balance > 0n) throw new AllSourcesFailedError("relics.owned", attempts);
      if (!verified) warnings.push({ code: "RPC_BALANCE_MISMATCH", message: `RPC discovery found ${discovered.relics.length} of ${balance} relics.`, source: "starknet-rpc" });
      const inventoryComplete = verified || discovered.complete;
      return toResult(context, startedAt, "starknet-rpc", {
        items: discovered.relics.map((relic) => ({ ...relic, owner, ownershipSource: "starknet-rpc" as const })),
        hasMore: !inventoryComplete,
        provenance: { owner, onchainBalance: balance, ownershipSource: "starknet-rpc", verified },
      }, attempts, verified && (!hydrateExternal || discovered.relics.every(metadataComplete)), warnings);
    } catch (error) {
      if (error instanceof AllSourcesFailedError) throw error;
      throw new AllSourcesFailedError("relics.owned", [...attempts, ...transportAttemptsFromError(error)]);
    }
  }

  const repository: RelicsRepository = {
    get,
    getMany,
    async all(input = {}, options = {}) {
      const startedAt = context.now();
      const collection = await repository.collection({ ...input, enrichFighters: false }, options);
      return toResult(context, startedAt, collection.meta.source, collection.data.items, collection.meta.attempts, collection.meta.complete, collection.meta.warnings);
    },
    page(input = {}, options = {}) { return repository.feed(input, options); },
    async feed(input = {}, options = {}) {
      const startedAt = context.now();
      const attempts: SourceAttempt[] = [];
      const warnings: DataWarning[] = [];
      const budget = resolveRequestBudget(context.budget, options);
      const size = clampPageSize(input.limit, 200, Math.min(200, budget.pageSize));
      const cursorState = decodeFeedCursor(input.cursor);

      if (context.torii && cursorState.kind !== "rpc") {
        const offset = cursorState.kind === "torii" || cursorState.kind === "legacy-torii"
          ? cursorState.offset
          : 0;
        const toriiLimit = cursorState.kind === "torii"
          ? cursorState.tokenRows
          : Number.MAX_SAFE_INTEGER;
        if (offset < toriiLimit) {
          try {
            const response = await context.torii.tokens(
              context.network.contracts.RelicNFT,
              { offset, limit: Math.min(size, toriiLimit - offset) },
              options,
            );
            attempts.push(...response.attempts);
            const toriiItems = response.data.edges.flatMap((edge) => {
              const mapped = edge.node.tokenMetadata ? mapToriiRelic(edge.node.tokenMetadata, context.network.contracts.RelicNFT) : undefined;
              return mapped ? [mapped] : [];
            });
            if (toriiItems.length > 0) {
              const items = await mapConcurrent(
                toriiItems,
                budget.maxConcurrency,
                (relic) => hydrateJson(context, relic, attempts, warnings, options),
              );
              const nextOffset = offset + response.data.edges.length;
              const tokenRows = Math.max(0, response.data.totalCount - 1);
              const hasMore = nextOffset < tokenRows;
              const oldestTokenId = toriiItems.at(-1)?.tokenId ?? 0n;
              const nextRpcCursor = oldestTokenId > 1n ? oldestTokenId - 1n : 0n;
              const next = hasMore
                ? toriiFeedCursor(nextOffset, tokenRows, nextRpcCursor)
                : 0n;
              return toResult(
                context,
                startedAt,
                "torii",
                { items, cursor: next, hasMore },
                attempts,
                items.every(metadataComplete),
                warnings,
              );
            }
            if (cursorState.kind === "start" && Math.max(0, response.data.totalCount - 1) === 0) {
              return toResult(context, startedAt, "torii", { items: [], cursor: 0n, hasMore: false }, attempts, true, warnings);
            }
            if (cursorState.kind === "torii" || response.data.edges.length > 0) {
              return toResult(context, startedAt, "torii", { items: [], cursor: 0n, hasMore: false }, attempts, true, warnings);
            }
          } catch (error) {
            attempts.push(...transportAttemptsFromError(error));
            warnings.push({ code: "TORII_UNAVAILABLE", message: "Torii relic inventory lookup failed.", source: "torii" });
          }
        }
      }

      const supported = context.capabilities.has("relicFeed") || await context.capabilities.probe("relicFeed", options.signal);
      if (supported) {
        const rpcSize = Math.min(size, 20);
        const rpcCursor = cursorState.kind === "torii" || cursorState.kind === "rpc"
          ? cursorState.rpcCursor
          : cursorState.kind === "legacy-torii"
            ? BigInt(cursorState.offset)
            : 0n;
        const response = await rpcCall(context, "get_relic_feed", [...encodeU256(rpcCursor), rpcSize.toString()], options);
        attempts.push(...response.attempts);
        const rows = decodeRelicRowsRpc(response.data);
        const items = await mapConcurrent(rows, context.budget.maxConcurrency, (relic) => hydrateJson(context, relic, attempts, warnings, options));
        const oldest = items.at(-1)?.tokenId ?? 0n;
        const cursor = oldest > 1n ? oldest - 1n : 0n;
        const hasMore = items.length === rpcSize && cursor > 0n;
        return toResult(context, startedAt, "starknet-rpc", {
          items,
          cursor: context.torii && hasMore ? rpcFeedCursor(cursor) : cursor,
          hasMore,
        }, attempts, items.every(metadataComplete), warnings);
      }
      if (context.torii) {
        warnings.push({
          code: "TORII_INVENTORY_UNVERIFIED",
          message: "Torii returned no RelicNFT inventory and this deployment lacks the aggregate RPC fallback.",
          source: "torii",
        });
        return toResult(context, startedAt, "torii", { items: [], cursor: input.cursor ?? 0n, hasMore: false }, attempts, false, warnings);
      }
      throw new UnsupportedCapabilityError("relic feed enumeration");
    },
    inventory(input = {}, options = {}) {
      return loadInventory(input, options);
    },
    async collection(input = {}, options = {}) {
      const startedAt = context.now();
      const inventory = await repository.inventory(input, options);
      const attempts = [...inventory.meta.attempts];
      const warnings = [...inventory.meta.warnings];
      const items = await mapConcurrent(
        inventory.data.items,
        resolveRequestBudget(context.budget, options).maxConcurrency,
        (relic) => metadataComplete(relic)
          ? Promise.resolve(relic)
          : hydrateJson(context, relic, attempts, warnings, options),
      );
      return toResult(
        context,
        startedAt,
        inventory.meta.source,
        { ...inventory.data, items },
        attempts,
        inventory.meta.complete && items.every(metadataComplete),
        warnings,
      );
    },
    async stats(filter = {}, options = {}) {
      const startedAt = context.now();
      const collection = await repository.inventory({}, options);
      const stats = summarizeRelicCollection(collection.data.items, filter, collection.data.fighters);
      return toResult(
        context,
        startedAt,
        "derived",
        stats,
        collection.meta.attempts,
        collection.meta.complete,
        [...collection.meta.warnings, ...stats.warnings],
      );
    },
    ownedInventory(owner, options = {}) {
      return loadOwned(owner, options, false);
    },
    owned(owner, options = {}) {
      return loadOwned(owner, options, true);
    },
    metadata: get,
    async owner(tokenId, options = {}) {
      const startedAt = context.now();
      const response = await rpcCall(context, "owner_of", encodeU256(tokenId), options);
      const value = response.data[0];
      if (!value) throw new ValidationError("Relic owner response was empty.");
      return toResult(context, startedAt, "starknet-rpc", normalizeAddress(value), response.attempts, true);
    },
  };
  return repository;
}
