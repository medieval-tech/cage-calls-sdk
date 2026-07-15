import { createDataResult, mapConcurrent, resolveRequestBudget } from "./core.js";
import { clampPageSize, encodeU256, normalizeAddress, sameAddress } from "./codecs.js";
import {
  decodeByteArrayRpc,
  decodeOwnedRelicPageRpc,
  decodeRelicDataRpc,
  decodeRelicRowsRpc,
  decodeSingleU256,
} from "./decoders.js";
import { AllSourcesFailedError, UnsupportedCapabilityError, ValidationError } from "./errors.js";
import type { RepositoryContext } from "./repositories.js";
import type {
  MetadataTransport,
  ToriiTokenNode,
} from "./transports.js";
import { transportAttemptsFromError } from "./transports.js";
import type {
  Address,
  DataResult,
  DataSource,
  DataWarning,
  Page,
  Relic,
  RelicMetadataAttribute,
  RelicOwnershipProvenance,
  RequestOptions,
  SourceAttempt,
} from "./types.js";

interface RelicContext extends RepositoryContext {
  metadata?: MetadataTransport;
}

export interface OwnedRelicsPage extends Page<Relic> {
  provenance: RelicOwnershipProvenance;
}

export type RelicMetadataMode = "external" | "onchain";

export interface RelicRequestOptions extends RequestOptions {
  metadata?: RelicMetadataMode;
}

export interface RelicFeedInput {
  limit?: number;
  cursor?: bigint;
  metadata?: RelicMetadataMode;
}

export interface RelicsRepository {
  get(tokenId: bigint, options?: RelicRequestOptions): Promise<DataResult<Relic>>;
  getMany(tokenIds: readonly bigint[], options?: RelicRequestOptions): Promise<DataResult<Relic[]>>;
  feed(input?: RelicFeedInput, options?: RequestOptions): Promise<DataResult<Page<Relic, bigint>>>;
  owned(owner: Address, options?: RequestOptions): Promise<DataResult<OwnedRelicsPage>>;
  metadata(tokenId: bigint, options?: RequestOptions): Promise<DataResult<Relic>>;
  owner(tokenId: bigint, options?: RequestOptions): Promise<DataResult<Address>>;
}

type DecodedRelicFeedCursor =
  | { kind: "start" }
  | { kind: "legacy-torii"; offset: number }
  | { kind: "torii"; offset: number; tokenRows: number; rpcCursor: bigint }
  | { kind: "rpc"; rpcCursor: bigint };

const TORII_TOKEN_OFFSET_WINDOW = 1_000;

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

function onchainComplete(relic: Relic): boolean {
  return Boolean(relic.owner && relic.metadata);
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

async function hydrateJson(context: RelicContext, relic: Relic, attempts: SourceAttempt[], warnings: DataWarning[], options: RelicRequestOptions): Promise<Relic> {
  if (options.metadata === "onchain") {
    const attributes = relic.attributes.length > 0 ? relic.attributes : onchainAttributes(relic);
    return { ...relic, attributes };
  }
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
  const get = async (tokenId: bigint, options: RelicRequestOptions = {}) => {
    if (tokenId <= 0n) throw new ValidationError("tokenId must be greater than zero.");
    const startedAt = context.now();
    const attempts: SourceAttempt[] = [];
    const warnings: DataWarning[] = [];
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
      let relic: Relic = {
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
      relic = await hydrateJson(context, relic, attempts, warnings, options);
      return toResult(
        context,
        startedAt,
        "starknet-rpc",
        relic,
        attempts,
        options.metadata === "onchain" ? onchainComplete(relic) : metadataComplete(relic),
        warnings,
      );
    } catch (error) {
      attempts.push(...transportAttemptsFromError(error));
      throw new AllSourcesFailedError("relics.get", attempts);
    }
  };

  const getMany = async (tokenIds: readonly bigint[], options: RelicRequestOptions = {}) => {
    const startedAt = context.now();
    const unique = Array.from(new Set(tokenIds));
    if (unique.length === 0) return toResult(context, startedAt, "derived", [], [], true);
    const supportsBatch = context.capabilities.has("relicBatch") || await context.capabilities.probe("relicBatch", options.signal);
    if (!supportsBatch) {
      const values = await mapConcurrent(unique, context.budget.maxConcurrency, (tokenId) => get(tokenId, options));
      return toResult(
        context,
        startedAt,
        "starknet-rpc",
        values.map((value) => value.data),
        values.flatMap((value) => value.meta.attempts),
        values.every((value) => value.meta.complete),
        values.flatMap((value) => value.meta.warnings),
      );
    }

    const relics: Relic[] = [];
    const attempts: SourceAttempt[] = [];
    const warnings: DataWarning[] = [];
    for (let index = 0; index < unique.length; index += 20) {
      const chunk = unique.slice(index, index + 20);
      const response = await rpcCall(context, "get_relics", [chunk.length.toString(), ...chunk.flatMap((tokenId) => encodeU256(tokenId))], options);
      attempts.push(...response.attempts);
      const rows = decodeRelicRowsRpc(response.data);
      const hydrated = await mapConcurrent(rows, context.budget.maxConcurrency, (row) => hydrateJson(context, row, attempts, warnings, options));
      relics.push(...hydrated);
      const present = new Set(rows.map((row) => row.tokenId));
      const missing = chunk.filter((tokenId) => !present.has(tokenId));
      if (missing.length > 0) warnings.push({ code: "MISSING_RELICS", message: `${missing.length} requested relic(s) were not returned.` });
    }
    const complete = options.metadata === "onchain"
      ? relics.length === unique.length && relics.every(onchainComplete)
      : relics.length === unique.length && relics.every(metadataComplete);
    return toResult(context, startedAt, "starknet-rpc", relics, attempts, complete, warnings);
  };

  async function hydrateToriiRelics(
    relics: Relic[],
    attempts: SourceAttempt[],
    warnings: DataWarning[],
    options: RequestOptions,
  ): Promise<Relic[]> {
    const incomplete = relics.filter((relic) => !metadataComplete(relic)).map((relic) => relic.tokenId);
    if (incomplete.length === 0) return relics;
    try {
      const hydrated = await getMany(incomplete, options);
      attempts.push(...hydrated.meta.attempts);
      warnings.push(...hydrated.meta.warnings);
      const byId = new Map(hydrated.data.map((relic) => [relic.tokenId.toString(), relic]));
      return relics.map((relic) => mergeRelic(relic, byId.get(relic.tokenId.toString()) ?? relic));
    } catch (error) {
      attempts.push(...transportAttemptsFromError(error));
      warnings.push({
        code: "TORII_METADATA_HYDRATION_FAILED",
        message: "Torii ownership was verified, but incomplete relic metadata could not be hydrated through RPC.",
        source: "starknet-rpc",
      });
      return relics;
    }
  }

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

  async function verifyToriiCandidates(
    owner: Address,
    candidates: Relic[],
    attempts: SourceAttempt[],
    warnings: DataWarning[],
    options: RequestOptions,
  ): Promise<Relic[]> {
    const verified = (await mapConcurrent(candidates, context.budget.maxConcurrency, async (relic) => {
      try {
        const response = await rpcCall(context, "owner_of", encodeU256(relic.tokenId), options);
        attempts.push(...response.attempts);
        return response.data[0] && sameAddress(response.data[0], owner) ? relic : undefined;
      } catch (error) {
        attempts.push(...transportAttemptsFromError(error));
        return undefined;
      }
    })).filter((value): value is Relic => value !== undefined);
    warnings.push({
      code: "TORII_CANDIDATE_RPC_VERIFICATION",
      message: `RPC ownership verification retained ${verified.length} of ${candidates.length} Torii relic candidates.`,
      source: "starknet-rpc",
    });
    return hydrateToriiRelics(verified, attempts, warnings, options);
  }

  async function verifyToriiInventory(
    owner: Address,
    attempts: SourceAttempt[],
    warnings: DataWarning[],
    options: RequestOptions,
  ): Promise<{ relics: Relic[]; complete: boolean }> {
    if (!context.torii) return { relics: [], complete: false };
    const budget = resolveRequestBudget(context.budget, options);
    const tokenIds: bigint[] = [];
    let offset = 0;
    let complete = false;
    for (let page = 0; page < budget.maxToriiPages && tokenIds.length < budget.maxToriiItems; page += 1) {
      const response = await context.torii.tokens(context.network.contracts.RelicNFT, { offset, limit: budget.pageSize }, options);
      attempts.push(...response.attempts);
      for (const edge of response.data.edges) {
        if (tokenIds.length >= budget.maxToriiItems) break;
        const token = edge.node.tokenMetadata;
        if (!token?.tokenId) continue;
        try { tokenIds.push(BigInt(token.tokenId)); } catch { /* skip malformed IDs */ }
      }
      offset += response.data.edges.length;
      if (response.data.edges.length === 0 || offset >= response.data.totalCount) {
        complete = true;
        break;
      }
    }
    if (!complete) {
      const itemLimit = tokenIds.length >= budget.maxToriiItems;
      warnings.push({
        code: itemLimit ? "TORII_ITEM_LIMIT" : "TORII_PAGE_LIMIT",
        message: itemLimit
          ? `Relic inventory verification reached the ${budget.maxToriiItems} item budget at offset ${offset}.`
          : `Relic inventory verification reached the ${budget.maxToriiPages} page budget at offset ${offset}.`,
        source: "torii",
      });
    }
    const ownedIds = (await mapConcurrent(tokenIds, context.budget.maxConcurrency, async (tokenId) => {
      try {
        const response = await rpcCall(context, "owner_of", encodeU256(tokenId), options);
        attempts.push(...response.attempts);
        return response.data[0] && sameAddress(response.data[0], owner) ? tokenId : undefined;
      } catch (error) {
        attempts.push(...transportAttemptsFromError(error));
        return undefined;
      }
    })).filter((value): value is bigint => value !== undefined);
    const hydrated = await getMany(ownedIds, options);
    attempts.push(...hydrated.meta.attempts);
    return { relics: hydrated.data, complete };
  }

  async function rpcOwned(
    owner: Address,
    expectedBalance: bigint,
    toriiInventory: { relics: Relic[]; complete: boolean },
    attempts: SourceAttempt[],
    warnings: DataWarning[],
    options: RequestOptions,
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
      const hydrated = await mapConcurrent(Array.from(relics.values()), context.budget.maxConcurrency, (relic) => hydrateJson(context, relic, attempts, warnings, options));
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
      const hydrated = await mapConcurrent(Array.from(relics.values()), context.budget.maxConcurrency, (relic) => hydrateJson(context, relic, attempts, warnings, options));
      return { relics: hydrated, complete };
    }

    if (toriiInventory.relics.length > 0) {
      const relics = await verifyToriiCandidates(owner, toriiInventory.relics, attempts, warnings, options);
      if (relics.length > 0) return { relics, complete: toriiInventory.complete };
    }

    warnings.push({ code: "TORII_INVENTORY_RPC_VERIFICATION", message: "The deployment lacks owner pagination; token ownership was verified individually through RPC.", source: "starknet-rpc" });
    return verifyToriiInventory(owner, attempts, warnings, options);
  }

  return {
    get,
    getMany,
    async feed(input = {}, options = {}) {
      const startedAt = context.now();
      const attempts: SourceAttempt[] = [];
      const warnings: DataWarning[] = [];
      const size = clampPageSize(input.limit, 20, 20);
      const metadata = input.metadata ?? "external";
      const cursorState = decodeFeedCursor(input.cursor);
      let toriiReturnedEmpty = false;

      if (context.torii && cursorState.kind !== "rpc") {
        const offset = cursorState.kind === "torii" || cursorState.kind === "legacy-torii"
          ? cursorState.offset
          : 0;
        const toriiLimit = cursorState.kind === "torii"
          ? Math.min(cursorState.tokenRows, TORII_TOKEN_OFFSET_WINDOW)
          : TORII_TOKEN_OFFSET_WINDOW;
        const exceedsToriiWindow = offset >= toriiLimit;
        if (exceedsToriiWindow) {
          warnings.push({
            code: "TORII_PAGINATION_LIMIT",
            message: "Torii's token query window was exhausted; relic enumeration continued through the aggregate RPC view.",
            source: "torii",
          });
        }
        if (!exceedsToriiWindow) {
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
              let items = toriiItems;
              const needsRpc = metadata === "onchain"
                ? items.map((relic) => relic.tokenId)
                : items.filter((relic) => !metadataComplete(relic)).map((relic) => relic.tokenId);
              if (needsRpc.length > 0) {
                try {
                  const hydrated = await getMany(needsRpc, { ...options, metadata });
                  attempts.push(...hydrated.meta.attempts);
                  warnings.push(...hydrated.meta.warnings);
                  const byId = new Map(hydrated.data.map((relic) => [relic.tokenId.toString(), relic]));
                  items = items.map((relic) => mergeRelic(relic, byId.get(relic.tokenId.toString()) ?? relic));
                } catch (error) {
                  attempts.push(...transportAttemptsFromError(error));
                  warnings.push({
                    code: "TORII_RELIC_ENRICHMENT_FAILED",
                    message: "Torii relic inventory was available, but structured onchain data could not be enriched through RPC.",
                    source: "starknet-rpc",
                  });
                }
              }
              const nextOffset = offset + response.data.edges.length;
              const tokenRows = Math.max(0, response.data.totalCount - 1);
              const hasMore = nextOffset < tokenRows;
              const oldestTokenId = toriiItems.at(-1)?.tokenId ?? 0n;
              const nextRpcCursor = oldestTokenId > 1n ? oldestTokenId - 1n : 0n;
              const next = hasMore
                ? nextOffset >= Math.min(tokenRows, TORII_TOKEN_OFFSET_WINDOW)
                  ? rpcFeedCursor(nextRpcCursor)
                  : toriiFeedCursor(nextOffset, tokenRows, nextRpcCursor)
                : 0n;
              const complete = metadata === "onchain" ? items.every(onchainComplete) : items.every(metadataComplete);
              return toResult(
                context,
                startedAt,
                "torii",
                { items, cursor: next, hasMore },
                attempts,
                complete,
                warnings,
              );
            }
            toriiReturnedEmpty = cursorState.kind === "start" && response.data.totalCount === 0;
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
        const rpcCursor = cursorState.kind === "torii" || cursorState.kind === "rpc"
          ? cursorState.rpcCursor
          : cursorState.kind === "legacy-torii"
            ? BigInt(cursorState.offset)
            : 0n;
        const response = await rpcCall(context, "get_relic_feed", [...encodeU256(rpcCursor), size.toString()], options);
        attempts.push(...response.attempts);
        const rows = decodeRelicRowsRpc(response.data);
        if (context.torii && toriiReturnedEmpty && rows.length > 0) {
          warnings.push({
            code: "TORII_INVENTORY_EMPTY",
            message: "Torii returned no RelicNFT inventory even though the contract returned relics.",
            source: "torii",
          });
        }
        const items = await mapConcurrent(rows, context.budget.maxConcurrency, (relic) => hydrateJson(context, relic, attempts, warnings, { ...options, metadata }));
        const oldest = items.at(-1)?.tokenId ?? 0n;
        const cursor = oldest > 1n ? oldest - 1n : 0n;
        const hasMore = items.length === size && cursor > 0n;
        const complete = metadata === "onchain" ? items.every(onchainComplete) : items.every(metadataComplete);
        return toResult(context, startedAt, "starknet-rpc", {
          items,
          cursor: context.torii && hasMore ? rpcFeedCursor(cursor) : cursor,
          hasMore,
        }, attempts, complete, warnings);
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
    async owned(ownerInput, options = {}) {
      const owner = normalizeAddress(ownerInput);
      const startedAt = context.now();
      const attempts: SourceAttempt[] = [];
      const warnings: DataWarning[] = [];
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
        }, attempts, true);
      }

      let toriiInventory: { relics: Relic[]; complete: boolean } = { relics: [], complete: false };
      if (context.torii) {
        try {
          toriiInventory = await toriiOwned(owner, attempts, warnings, options);
          let torii = toriiInventory.relics;
          if (BigInt(torii.length) === balance) {
            torii = await hydrateToriiRelics(torii, attempts, warnings, options);
            return toResult(context, startedAt, "torii", {
              items: torii.map((relic) => ({ ...relic, owner, ownershipSource: "torii" as const })),
              hasMore: false,
              provenance: { owner, onchainBalance: balance, ownershipSource: "torii", verified: true },
            }, attempts, torii.every(metadataComplete), warnings);
          }
          warnings.push({ code: "TORII_BALANCE_MISMATCH", message: `Torii returned ${torii.length} of ${balance} owned relics.`, source: "torii" });
        } catch (error) {
          attempts.push(...transportAttemptsFromError(error));
          warnings.push({ code: "TORII_UNAVAILABLE", message: "Torii ownership lookup failed.", source: "torii" });
        }
      }

      try {
        const discovered = await rpcOwned(owner, balance, toriiInventory, attempts, warnings, options);
        const verified = BigInt(discovered.relics.length) === balance;
        if (discovered.relics.length === 0 && balance > 0n) throw new AllSourcesFailedError("relics.owned", attempts);
        if (!verified) warnings.push({ code: "RPC_BALANCE_MISMATCH", message: `RPC discovery found ${discovered.relics.length} of ${balance} relics.`, source: "starknet-rpc" });
        const inventoryComplete = verified || discovered.complete;
        return toResult(context, startedAt, "starknet-rpc", {
          items: discovered.relics.map((relic) => ({ ...relic, owner, ownershipSource: "starknet-rpc" as const })),
          hasMore: !inventoryComplete,
          provenance: { owner, onchainBalance: balance, ownershipSource: "starknet-rpc", verified },
        }, attempts, verified && discovered.relics.every(metadataComplete), warnings);
      } catch (error) {
        if (error instanceof AllSourcesFailedError) throw error;
        throw new AllSourcesFailedError("relics.owned", [...attempts, ...transportAttemptsFromError(error)]);
      }
    },
    metadata(tokenId, options = {}) {
      return get(tokenId, { ...options, metadata: "external" });
    },
    async owner(tokenId, options = {}) {
      const startedAt = context.now();
      const response = await rpcCall(context, "owner_of", encodeU256(tokenId), options);
      const value = response.data[0];
      if (!value) throw new ValidationError("Relic owner response was empty.");
      return toResult(context, startedAt, "starknet-rpc", normalizeAddress(value), response.attempts, true);
    },
  };
}
