import { createDataResult, mapConcurrent, resolveRequestBudget } from "../core/request.js";
import { clampPageSize, encodeU256, normalizeAddress, normalizeFelt } from "../core/codecs.js";
import {
  decodeFightBuyRpc,
  decodeFightBuysRpc,
  decodeFightFeedRpc,
  decodeFightRpc,
  decodeFightersRpc,
  decodeFighterRpc,
  decodeFightWinnerRpc,
  decodeGachaPoolStateRpc,
  decodeGachaPoolStatesRpc,
  decodeGachaUserStatesRpc,
  decodeMarketRpc,
  decodeSingleBool,
  decodeSingleNumber,
  decodeSingleU256,
  mapToriiFight,
  mapToriiFightBuy,
  mapToriiFightWinner,
  mapToriiFighter,
  mapToriiMarket,
  scalarBigInt,
  scalarNumber,
} from "../core/decoders.js";
import { AllSourcesFailedError, UnsupportedCapabilityError, ValidationError } from "../core/errors.js";
import type { CapabilityRegistry } from "../network.js";
import type { RpcTransport, ToriiTransport, TransportResult } from "../transports/index.js";
import { transportAttemptsFromError } from "../transports/index.js";
import { readAllToriiModels } from "../transports/torii-models.js";
import type {
  Address,
  CageCallsNetwork,
  DataResult,
  DataWarning,
  Fight,
  FightBuy,
  FightEvent,
  FightFeedItem,
  FightPotState,
  FightViewerState,
  FightWinner,
  Fighter,
  GachaFightUserState,
  GachaPoolState,
  GachaUserState,
  GachaUserStates,
  Market,
  MarketCatalogItem,
  MarketPosition,
  MarketState,
  Page,
  RequestBudget,
  RequestOptions,
  SdkLogger,
  SourceAttempt,
} from "../core/types.js";

export interface RepositoryContext {
  network: Readonly<CageCallsNetwork>;
  rpc: RpcTransport;
  torii?: ToriiTransport;
  capabilities: CapabilityRegistry;
  budget: RequestBudget;
  now: () => number;
  logger?: SdkLogger;
}

function result<T>(
  context: RepositoryContext,
  startedAt: number,
  source: DataResult<T>["meta"]["source"],
  data: T,
  attempts: SourceAttempt[],
  complete = true,
  warnings: DataWarning[] = [],
  blockNumber?: bigint,
): DataResult<T> {
  return createDataResult({
    data,
    source,
    complete,
    attempts,
    warnings,
    startedAt,
    now: context.now,
    ...(blockNumber === undefined ? {} : { blockNumber }),
    ...(context.logger ? { logger: context.logger } : {}),
  });
}

function rpcCall(context: RepositoryContext, contract: keyof CageCallsNetwork["contracts"], entrypoint: string, calldata: string[], options?: RequestOptions) {
  return context.rpc.call({ contractAddress: context.network.contracts[contract], entrypoint, calldata }, options);
}

const FIGHTER_SELECTION = ["fighter_id", "name", "weight_class", "active"] as const;
const FIGHT_SELECTION = [
  "fight_id", "season_id", "event", "market_id", "fighter_a_id", "fighter_a_name",
  "fighter_a_weight_class", "choice_a_value", "choice_a_label", "fighter_b_id",
  "fighter_b_name", "fighter_b_weight_class", "choice_b_value", "choice_b_label",
  "created_at", "is_dev", "sponsor",
] as const;
const FIGHT_BUY_SELECTION = ["fight_id", "buyer", "market_id", "choice_index", "amount", "bought_at"] as const;
const FIGHT_WINNER_SELECTION = ["fight_id", "winner", "choice_index", "redeemed"] as const;
const MARKET_SELECTION = [
  "market_id", "creator", "created_at", "question_id", "condition_id", "oracle",
  "outcome_slot_count", "collateral_token", "start_at", "end_at", "resolve_at", "resolved_at",
] as const;
const VAULT_NUMERATOR_SELECTION = ["market_id", "index", "value"] as const;
const VAULT_DENOMINATOR_SELECTION = ["market_id", "value"] as const;

export interface FightersRepository {
  get(fighterId: bigint, options?: RequestOptions): Promise<DataResult<Fighter>>;
  getMany(fighterIds: readonly bigint[], options?: RequestOptions): Promise<DataResult<Fighter[]>>;
  all(input?: { active?: boolean }, options?: RequestOptions): Promise<DataResult<Fighter[]>>;
  page(input?: { active?: boolean; limit?: number; cursor?: string }, options?: RequestOptions): Promise<DataResult<Page<Fighter>>>;
  /** @deprecated Use page(). */
  list(input?: { active?: boolean; limit?: number; cursor?: string }, options?: RequestOptions): Promise<DataResult<Page<Fighter>>>;
  isAdmin(account: Address, options?: RequestOptions): Promise<DataResult<boolean>>;
}

export function createFightersRepository(context: RepositoryContext): FightersRepository {
  const get = async (fighterId: bigint, options: RequestOptions = {}) => {
    if (fighterId <= 0n) throw new ValidationError("fighterId must be greater than zero.");
    const startedAt = context.now();
    const calldata = encodeU256(fighterId);
    try {
      const response = await rpcCall(context, "FighterRegistry", "get_fighter", calldata, options);
      return result(context, startedAt, "starknet-rpc", decodeFighterRpc(response.data), response.attempts, true, [], response.blockNumber);
    } catch (rpcError) {
      const attempts = transportAttemptsFromError(rpcError);
      if (!context.torii) throw new AllSourcesFailedError("fighters.get", attempts);
      try {
        const response = await context.torii.model<Record<string, unknown>>({
          model: "Fighter",
          selection: FIGHTER_SELECTION,
          first: 1,
          where: { fighter_idEQ: normalizeFelt(fighterId) },
        }, options);
        const node = response.data.edges[0]?.node;
        if (!node) throw new AllSourcesFailedError("fighters.get", [...attempts, ...response.attempts]);
        return result(context, startedAt, "torii", mapToriiFighter(node), [...attempts, ...response.attempts], false, [{
          code: "RPC_VERIFICATION_UNAVAILABLE",
          message: "Fighter was returned by Torii but could not be verified through RPC.",
          source: "starknet-rpc",
        }]);
      } catch (toriiError) {
        throw new AllSourcesFailedError("fighters.get", [...attempts, ...transportAttemptsFromError(toriiError)]);
      }
    }
  };

  const page = async (input: { active?: boolean; limit?: number; cursor?: string } = {}, options: RequestOptions = {}) => {
    const startedAt = context.now();
    if (!context.torii) throw new UnsupportedCapabilityError("fighter enumeration without Torii");
    try {
      const response = await context.torii.model<Record<string, unknown>>({
        model: "Fighter",
        selection: FIGHTER_SELECTION,
        first: clampPageSize(input.limit, context.budget.pageSize, 20),
        ...(input.cursor ? { after: input.cursor } : {}),
        ...(input.active === undefined ? {} : { where: { active: input.active } }),
      }, options);
      return result(context, startedAt, "torii", {
        items: response.data.edges.map((edge) => mapToriiFighter(edge.node)),
        ...(response.data.pageInfo.endCursor ? { cursor: response.data.pageInfo.endCursor } : {}),
        hasMore: response.data.pageInfo.hasNextPage,
      }, response.attempts);
    } catch (error) {
      throw new AllSourcesFailedError("fighters.page", transportAttemptsFromError(error));
    }
  };

  return {
    get,
    async getMany(fighterIds, options = {}) {
      const startedAt = context.now();
      const unique = Array.from(new Set(fighterIds));
      if (unique.length === 0) return result(context, startedAt, "derived", [], []);
      const supportsBatch = context.capabilities.has("fighterBatch") || await context.capabilities.probe("fighterBatch", options.signal);
      if (supportsBatch) {
        const fighters: Fighter[] = [];
        const attempts: SourceAttempt[] = [];
        for (let index = 0; index < unique.length; index += 20) {
          const chunk = unique.slice(index, index + 20);
          const calldata = [chunk.length.toString(), ...chunk.flatMap(encodeU256)];
          const response = await rpcCall(context, "FighterRegistry", "get_fighters", calldata, options);
          attempts.push(...response.attempts);
          fighters.push(...decodeFightersRpc(response.data));
        }
        return result(context, startedAt, "starknet-rpc", fighters, attempts);
      }
      const values = await mapConcurrent(unique, context.budget.maxConcurrency, (fighterId) => get(fighterId, options));
      return result(
        context,
        startedAt,
        values.some((value) => value.meta.source === "starknet-rpc") ? "starknet-rpc" : "torii",
        values.map((value) => value.data),
        values.flatMap((value) => value.meta.attempts),
        values.every((value) => value.meta.complete),
        values.flatMap((value) => value.meta.warnings),
      );
    },
    async all(input = {}, options = {}) {
      const startedAt = context.now();
      if (!context.torii) throw new UnsupportedCapabilityError("fighter enumeration without Torii");
      try {
        const response = await readAllToriiModels(context, {
          model: "Fighter",
          selection: FIGHTER_SELECTION,
          ...(input.active === undefined ? {} : { where: { active: input.active } }),
        }, mapToriiFighter, options);
        return result(context, startedAt, "torii", response.items, response.attempts, response.complete, response.warnings);
      } catch (error) {
        throw new AllSourcesFailedError("fighters.all", transportAttemptsFromError(error));
      }
    },
    page,
    list: page,
    async isAdmin(account, options = {}) {
      const startedAt = context.now();
      const response = await rpcCall(context, "FighterRegistry", "is_admin", [normalizeAddress(account)], options);
      return result(context, startedAt, "starknet-rpc", decodeSingleBool(response.data, "fighterRegistry.isAdmin"), response.attempts);
    },
  };
}

export interface FightsRepository {
  get(fightId: bigint, options?: RequestOptions): Promise<DataResult<Fight>>;
  all(input?: { seasonId?: bigint }, options?: RequestOptions): Promise<DataResult<Fight[]>>;
  page(input?: { limit?: number; cursor?: string; seasonId?: bigint }, options?: RequestOptions): Promise<DataResult<Page<Fight>>>;
  /** @deprecated Use page(). */
  list(input?: { limit?: number; cursor?: string; seasonId?: bigint }, options?: RequestOptions): Promise<DataResult<Page<Fight>>>;
  feed(input?: { limit?: number; cursor?: bigint; viewer?: Address }, options?: RequestOptions): Promise<DataResult<Page<FightFeedItem, bigint>>>;
  feedMany(fightIds: readonly bigint[], input?: { viewer?: Address }, options?: RequestOptions): Promise<DataResult<FightFeedItem[]>>;
  feedAll(input?: { viewer?: Address }, options?: RequestOptions): Promise<DataResult<FightFeedItem[]>>;
  accountFeed(account: Address, input?: { limit?: number; cursor?: bigint }, options?: RequestOptions): Promise<DataResult<Page<FightFeedItem, bigint>>>;
  accountFeedAll(account: Address, options?: RequestOptions): Promise<DataResult<FightFeedItem[]>>;
  buys(fightId: bigint, input?: { offset?: number; limit?: number }, options?: RequestOptions): Promise<DataResult<Page<FightBuy, number>>>;
  buysAll(fightId: bigint, options?: RequestOptions): Promise<DataResult<FightBuy[]>>;
  viewerState(fightId: bigint, viewer: Address, options?: RequestOptions): Promise<DataResult<FightViewerState>>;
  potState(fightId: bigint, options?: RequestOptions): Promise<DataResult<FightPotState>>;
  winner(fightId: bigint, account: Address, options?: RequestOptions): Promise<DataResult<FightWinner | undefined>>;
  portfolio(account: Address, input?: { limit?: number; cursor?: string }, options?: RequestOptions): Promise<DataResult<Page<FightBuy>>>;
  portfolioAll(account: Address, options?: RequestOptions): Promise<DataResult<FightBuy[]>>;
}

export function createFightsRepository(context: RepositoryContext): FightsRepository {
  const get = async (fightId: bigint, options: RequestOptions = {}) => {
    const startedAt = context.now();
    const response = await rpcCall(context, "FightFactory", "fight", encodeU256(fightId), options);
    return result(context, startedAt, "starknet-rpc", decodeFightRpc(response.data), response.attempts, true, [], response.blockNumber);
  };

  const list = async (input: { limit?: number; cursor?: string; seasonId?: bigint } = {}, options: RequestOptions = {}) => {
    const startedAt = context.now();
    const attempts: SourceAttempt[] = [];
    if (context.torii) {
      try {
        const response = await context.torii.model<Record<string, unknown>>({
          model: "Fight",
          selection: FIGHT_SELECTION,
          first: clampPageSize(input.limit, context.budget.pageSize, 20),
          ...(input.cursor ? { after: input.cursor } : {}),
          ...(input.seasonId === undefined ? {} : { where: { season_idEQ: normalizeFelt(input.seasonId) } }),
        }, options);
        const items = response.data.edges.map((edge) => mapToriiFight(edge.node)).sort((a, b) => a.createdAt > b.createdAt ? -1 : 1);
        return result(context, startedAt, "torii", {
          items,
          ...(response.data.pageInfo.endCursor ? { cursor: response.data.pageInfo.endCursor } : {}),
          hasMore: response.data.pageInfo.hasNextPage,
        }, response.attempts);
      } catch (error) {
        attempts.push(...transportAttemptsFromError(error));
      }
    }

    const size = clampPageSize(input.limit, 20, 20);
    const nextIdResponse = await rpcCall(context, "FightFactory", "next_fight_id", [], options).catch((error) => {
      throw new AllSourcesFailedError("fights.list", [...attempts, ...transportAttemptsFromError(error)]);
    });
    attempts.push(...nextIdResponse.attempts);
    const nextId = decodeSingleU256(nextIdResponse.data, "nextFightId");
    let cursor = input.cursor ? BigInt(input.cursor) : nextId > 0n ? nextId - 1n : 0n;
    const ids: bigint[] = [];
    while (cursor > 0n && ids.length < size) ids.push(cursor--);
    const fights = await mapConcurrent(ids, context.budget.maxConcurrency, async (id) => {
      const value = await get(id, options);
      attempts.push(...value.meta.attempts);
      return value.data;
    });
    return result(context, startedAt, "starknet-rpc", {
      items: input.seasonId === undefined ? fights : fights.filter((fight) => fight.seasonId === input.seasonId),
      ...(cursor > 0n ? { cursor: cursor.toString() } : {}),
      hasMore: cursor > 0n,
    }, attempts, false, [{ code: "TORII_FALLBACK", message: "Fight enumeration used bounded singleton RPC reads.", source: "starknet-rpc" }]);
  };

  return {
    get,
    async all(input = {}, options = {}) {
      const startedAt = context.now();
      const attempts: SourceAttempt[] = [];
      const warnings: DataWarning[] = [];
      if (context.torii) {
        try {
          const response = await readAllToriiModels(context, {
            model: "Fight",
            selection: FIGHT_SELECTION,
            ...(input.seasonId === undefined ? {} : { where: { season_idEQ: normalizeFelt(input.seasonId) } }),
          }, mapToriiFight, options);
          return result(context, startedAt, "torii", response.items.sort((a, b) => a.createdAt === b.createdAt ? 0 : a.createdAt > b.createdAt ? -1 : 1), response.attempts, response.complete, response.warnings);
        } catch (error) {
          attempts.push(...transportAttemptsFromError(error));
          warnings.push({ code: "TORII_UNAVAILABLE", message: "Fight enumeration fell back to aggregate RPC pages.", source: "torii" });
        }
      }
      const supportsFeed = context.capabilities.has("fightFeed") || await context.capabilities.probe("fightFeed", options.signal);
      if (supportsFeed) {
        const response = await createFightsRepository(context).feedAll({}, options);
        attempts.push(...response.meta.attempts);
        warnings.push(...response.meta.warnings);
        const items = response.data
          .filter((fight) => input.seasonId === undefined || fight.seasonId === input.seasonId)
          .sort((a, b) => a.createdAt === b.createdAt ? 0 : a.createdAt > b.createdAt ? -1 : 1);
        return result(context, startedAt, "starknet-rpc", items, attempts, response.meta.complete, warnings);
      }
      const budget = resolveRequestBudget(context.budget, options);
      const next = await rpcCall(context, "FightFactory", "next_fight_id", [], options).catch((error) => {
        throw new AllSourcesFailedError("fights.all", [...attempts, ...transportAttemptsFromError(error)]);
      });
      attempts.push(...next.attempts);
      const nextId = decodeSingleU256(next.data, "nextFightId");
      const ids: bigint[] = [];
      for (let id = 1n; id < nextId && ids.length < budget.maxRpcItems; id += 1n) ids.push(id);
      const values = await mapConcurrent(ids, context.budget.maxConcurrency, (id) => get(id, options));
      attempts.push(...values.flatMap((value) => value.meta.attempts));
      const items = values.map((value) => value.data)
        .filter((fight) => input.seasonId === undefined || fight.seasonId === input.seasonId)
        .sort((a, b) => a.createdAt === b.createdAt ? 0 : a.createdAt > b.createdAt ? -1 : 1);
      const complete = BigInt(ids.length) === (nextId > 0n ? nextId - 1n : 0n);
      if (!complete) warnings.push({ code: "RPC_ITEM_LIMIT", message: `Fight enumeration reached the ${budget.maxRpcItems} item budget.`, source: "starknet-rpc" });
      return result(context, startedAt, "starknet-rpc", items, attempts, complete, warnings);
    },
    page: list,
    list,
    async feedMany(fightIds, input = {}, options = {}) {
      const startedAt = context.now();
      const budget = resolveRequestBudget(context.budget, options);
      const unique = Array.from(new Set(fightIds.map((fightId) => {
        if (fightId <= 0n) throw new ValidationError("fightIds must contain positive identifiers.");
        return fightId.toString();
      }))).map(BigInt);
      if (unique.length === 0) return result(context, startedAt, "derived", [], []);
      if (unique.length > budget.maxRpcItems) {
        throw new ValidationError(`fightIds exceeds the ${budget.maxRpcItems} RPC item budget.`);
      }

      const viewer = normalizeAddress(input.viewer ?? "0x0");
      const attempts: SourceAttempt[] = [];
      const warnings: DataWarning[] = [];
      const rows: FightFeedItem[] = [];
      const supported = context.capabilities.has("fightFeedByIds")
        || await context.capabilities.probe("fightFeedByIds", options.signal);

      if (supported) {
        for (let offset = 0; offset < unique.length; offset += 20) {
          const ids = unique.slice(offset, offset + 20);
          const response = await rpcCall(context, "FightFactory", "get_fight_feed_by_ids", [
            ids.length.toString(),
            ...ids.flatMap(encodeU256),
            viewer,
          ], options);
          attempts.push(...response.attempts);
          rows.push(...decodeFightFeedRpc(response.data));
        }
      } else {
        const fallback = await mapConcurrent(unique, budget.maxConcurrency, async (fightId) => {
          const page = await createFightsRepository(context).feed({ cursor: fightId, limit: 1, ...(input.viewer ? { viewer: input.viewer } : {}) }, options);
          return { row: page.data.items.find((item) => item.fightId === fightId), meta: page.meta };
        });
        attempts.push(...fallback.flatMap((value) => value.meta.attempts));
        warnings.push(...fallback.flatMap((value) => value.meta.warnings));
        rows.push(...fallback.flatMap((value) => value.row ? [value.row] : []));
        warnings.push({
          code: "CAPABILITY_FALLBACK",
          message: "Exact fight batches used bounded per-fight feed reads because get_fight_feed_by_ids is unavailable.",
          source: "starknet-rpc",
        });
      }

      const byId = new Map(rows.map((row) => [row.fightId.toString(), row]));
      const ordered = unique.flatMap((fightId) => {
        const row = byId.get(fightId.toString());
        return row ? [row] : [];
      });
      const complete = ordered.length === unique.length;
      if (!complete) warnings.push({
        code: "PARTIAL_AGGREGATE",
        message: `Fight batch returned ${ordered.length} of ${unique.length} requested fights.`,
        source: "starknet-rpc",
      });
      return result(context, startedAt, "starknet-rpc", ordered, attempts, complete && supported, warnings);
    },
    async feedAll(input = {}, options = {}) {
      const startedAt = context.now();
      const budget = resolveRequestBudget(context.budget, options);
      const items: FightFeedItem[] = [];
      const attempts: SourceAttempt[] = [];
      const warnings: DataWarning[] = [];
      const seen = new Set<string>();
      let cursor = 0n;
      let exhausted = false;
      let complete = true;
      for (let pageIndex = 0; pageIndex < budget.maxRpcPages && items.length < budget.maxRpcItems; pageIndex += 1) {
        const response = await createFightsRepository(context).feed({
          ...input,
          cursor,
          limit: Math.min(20, budget.maxRpcItems - items.length),
        }, options);
        items.push(...response.data.items);
        attempts.push(...response.meta.attempts);
        warnings.push(...response.meta.warnings);
        complete &&= response.meta.complete;
        if (!response.data.hasMore) { exhausted = true; break; }
        const next = response.data.cursor ?? 0n;
        const key = next.toString();
        if (seen.has(key) || next === cursor) {
          warnings.push({ code: "RPC_CURSOR_STALLED", message: `Fight feed pagination stopped at repeated cursor ${next}.`, source: "starknet-rpc" });
          complete = false;
          break;
        }
        seen.add(key);
        cursor = next;
      }
      if (!exhausted) {
        complete = false;
        warnings.push({
          code: items.length >= budget.maxRpcItems ? "RPC_ITEM_LIMIT" : "RPC_PAGE_LIMIT",
          message: items.length >= budget.maxRpcItems
            ? `Fight feed enumeration reached the ${budget.maxRpcItems} item budget.`
            : `Fight feed enumeration reached the ${budget.maxRpcPages} page budget.`,
          source: "starknet-rpc",
        });
      }
      return result(context, startedAt, "starknet-rpc", items, attempts, complete && exhausted, warnings);
    },
    async feed(input = {}, options = {}) {
      const startedAt = context.now();
      const supported = context.capabilities.has("fightFeed") || await context.capabilities.probe("fightFeed", options.signal);
      const size = clampPageSize(input.limit, 20, 20);
      const viewer = normalizeAddress(input.viewer ?? "0x0");
      if (supported) {
        const start = input.cursor ?? 0n;
        const response = await rpcCall(context, "FightFactory", "get_fight_feed", [
          ...encodeU256(start),
          size.toString(),
          viewer,
        ], options);
        const items = decodeFightFeedRpc(response.data);
        const oldest = items.at(-1)?.fightId ?? 0n;
        const cursor = oldest > 1n ? oldest - 1n : 0n;
        return result(context, startedAt, "starknet-rpc", { items, cursor, hasMore: items.length === size && cursor > 0n }, response.attempts);
      }

      const attempts: SourceAttempt[] = [];
      let cursor = input.cursor ?? 0n;
      if (cursor === 0n) {
        const next = await rpcCall(context, "FightFactory", "next_fight_id", [], options);
        attempts.push(...next.attempts);
        const nextId = decodeSingleU256(next.data, "nextFightId");
        cursor = nextId > 0n ? nextId - 1n : 0n;
      }
      const ids: bigint[] = [];
      while (cursor > 0n && ids.length < size) ids.push(cursor--);
      const markets = createMarketsRepository(context);
      const items = await mapConcurrent(ids, context.budget.maxConcurrency, async (fightId): Promise<FightFeedItem> => {
        const fightResult = await get(fightId, options);
        const marketResult = await markets.get(fightResult.data.marketId, options);
        const [stateResult, potResult, viewerResult] = await Promise.all([
          markets.state(marketResult.data.marketId, marketResult.data.outcomeSlotCount, marketResult.data.conditionId, options),
          createFightsRepository(context).potState(fightId, options),
          viewer === normalizeAddress("0")
            ? Promise.resolve(result(context, startedAt, "derived", {
                hasBought: false,
                shares: 0n,
                boughtAt: 0n,
                hasRedeemed: false,
                isWinner: false,
                strikeTickets: 0n,
              }, []))
            : createFightsRepository(context).viewerState(fightId, viewer, options),
        ]);
        attempts.push(
          ...fightResult.meta.attempts,
          ...marketResult.meta.attempts,
          ...stateResult.meta.attempts,
          ...potResult.meta.attempts,
          ...viewerResult.meta.attempts,
        );
        const market = marketResult.data;
        return {
          ...fightResult.data,
          marketCreatedAt: market.createdAt,
          conditionId: market.conditionId,
          oracle: market.oracle,
          outcomeSlotCount: market.outcomeSlotCount,
          collateralToken: market.collateralToken,
          startAt: market.startAt ?? 0n,
          endAt: market.endAt ?? 0n,
          resolveAt: market.resolveAt ?? 0n,
          resolvedAt: market.resolvedAt ?? 0n,
          vaultNumerators: stateResult.data.vaultNumerators,
          vaultDenominator: stateResult.data.vaultDenominator,
          outcomeCounts: [],
          outcomeShares: stateResult.data.outcomeShares ?? [],
          payoutNumerators: stateResult.data.payoutNumerators,
          payoutDenominator: stateResult.data.payoutDenominator,
          pot: potResult.data,
          viewer: viewerResult.data,
        };
      });
      return result(context, startedAt, "starknet-rpc", {
        items,
        cursor,
        hasMore: ids.length === size && cursor > 0n,
      }, attempts, false, [{
        code: "AGGREGATE_VIEW_FALLBACK",
        message: "Fight feed used bounded singleton RPC views because the aggregate view is unavailable.",
        source: "starknet-rpc",
      }]);
    },
    async accountFeed(account, input = {}, options = {}) {
      const startedAt = context.now();
      const supported = context.capabilities.has("accountFightFeed")
        || await context.capabilities.probe("accountFightFeed", options.signal);
      if (!supported) throw new UnsupportedCapabilityError("account fight feed");
      const size = clampPageSize(input.limit, 20, 20);
      const response = await rpcCall(context, "FightFactory", "get_account_fight_feed", [
        normalizeAddress(account),
        ...encodeU256(input.cursor ?? 0n),
        size.toString(),
      ], options);
      const items = decodeFightFeedRpc(response.data);
      const oldest = items.at(-1)?.fightId ?? 0n;
      const cursor = oldest > 1n ? oldest - 1n : 0n;
      return result(context, startedAt, "starknet-rpc", {
        items,
        cursor,
        hasMore: items.length === size && cursor > 0n,
      }, response.attempts);
    },
    async accountFeedAll(account, options = {}) {
      const startedAt = context.now();
      const budget = resolveRequestBudget(context.budget, options);
      const items: FightFeedItem[] = [];
      const attempts: SourceAttempt[] = [];
      const warnings: DataWarning[] = [];
      let cursor = 0n;
      let exhausted = false;
      for (let pageIndex = 0; pageIndex < budget.maxRpcPages && items.length < budget.maxRpcItems; pageIndex += 1) {
        const page = await createFightsRepository(context).accountFeed(account, {
          cursor,
          limit: Math.min(20, budget.maxRpcItems - items.length),
        }, options);
        items.push(...page.data.items);
        attempts.push(...page.meta.attempts);
        if (!page.data.hasMore) { exhausted = true; break; }
        const next = page.data.cursor ?? 0n;
        if (next === 0n || next === cursor) {
          warnings.push({ code: "RPC_CURSOR_STALLED", message: `Account fight feed stopped at cursor ${next}.`, source: "starknet-rpc" });
          break;
        }
        cursor = next;
      }
      if (!exhausted) warnings.push({
        code: items.length >= budget.maxRpcItems ? "RPC_ITEM_LIMIT" : "RPC_PAGE_LIMIT",
        message: "Account fight feed stopped at the configured traversal budget.",
        source: "starknet-rpc",
      });
      return result(context, startedAt, "starknet-rpc", items, attempts, exhausted, warnings);
    },
    async buys(fightId, input = {}, options = {}) {
      const startedAt = context.now();
      const offset = input.offset ?? 0;
      if (!Number.isSafeInteger(offset) || offset < 0) throw new ValidationError("offset must be a non-negative safe integer.");
      const size = clampPageSize(input.limit, 100, 100);
      const attempts: SourceAttempt[] = [];
      const supported = context.capabilities.has("fightBuyPagination") || await context.capabilities.probe("fightBuyPagination", options.signal);
      if (supported) {
        const [rows, count] = await Promise.all([
          rpcCall(context, "FightFactory", "get_fight_buys", [...encodeU256(fightId), offset.toString(), size.toString()], options),
          rpcCall(context, "FightFactory", "fight_buy_count", encodeU256(fightId), options),
        ]);
        attempts.push(...rows.attempts, ...count.attempts);
        const items = decodeFightBuysRpc(rows.data);
        const total = decodeSingleNumber(count.data, "fightBuyCount");
        return result(context, startedAt, "starknet-rpc", {
          items,
          ...(offset + items.length < total ? { cursor: offset + items.length } : {}),
          hasMore: offset + items.length < total,
        }, attempts);
      }
      if (!context.torii) throw new UnsupportedCapabilityError("fight buy enumeration");
      const budget = resolveRequestBudget(context.budget, options);
      const requestedEnd = offset + size;
      const fetchSize = Math.min(requestedEnd, budget.maxToriiItems);
      const response = await context.torii.model<Record<string, unknown>>({
        model: "FightBuy",
        selection: FIGHT_BUY_SELECTION,
        first: Math.max(1, fetchSize),
        where: { fight_idEQ: normalizeFelt(fightId) },
      }, options);
      const items = response.data.edges.slice(offset, requestedEnd).map((edge) => mapToriiFightBuy(edge.node));
      const nextOffset = offset + items.length;
      const hasMore = nextOffset < response.data.totalCount;
      const budgetCapped = requestedEnd > budget.maxToriiItems;
      return result(context, startedAt, "torii", {
        items,
        ...(hasMore && items.length > 0 ? { cursor: nextOffset } : {}),
        hasMore,
      }, response.attempts, !budgetCapped, budgetCapped ? [{
        code: "BUDGET_LIMIT",
        message: `Fight buy pagination is capped at ${budget.maxToriiItems} Torii records.`,
        source: "torii",
      }] : []);
    },
    async buysAll(fightId, options = {}) {
      const startedAt = context.now();
      const attempts: SourceAttempt[] = [];
      const warnings: DataWarning[] = [];
      if (context.torii) {
        try {
          const response = await readAllToriiModels(context, {
            model: "FightBuy",
            selection: FIGHT_BUY_SELECTION,
            where: { fight_idEQ: normalizeFelt(fightId) },
          }, mapToriiFightBuy, options);
          return result(context, startedAt, "torii", response.items, response.attempts, response.complete, response.warnings);
        } catch (error) {
          attempts.push(...transportAttemptsFromError(error));
          warnings.push({ code: "TORII_UNAVAILABLE", message: "Fight buy enumeration fell back to aggregate RPC pages.", source: "torii" });
        }
      }
      const supported = context.capabilities.has("fightBuyPagination") || await context.capabilities.probe("fightBuyPagination", options.signal);
      if (!supported) throw new UnsupportedCapabilityError("fight buy exhaustive enumeration");
      const budget = resolveRequestBudget(context.budget, options);
      const count = await rpcCall(context, "FightFactory", "fight_buy_count", encodeU256(fightId), options);
      attempts.push(...count.attempts);
      const total = decodeSingleNumber(count.data, "fightBuyCount");
      const items: FightBuy[] = [];
      for (let offset = 0, pageIndex = 0; offset < total && pageIndex < budget.maxRpcPages && items.length < budget.maxRpcItems; pageIndex += 1) {
        const size = Math.min(100, total - offset, budget.maxRpcItems - items.length);
        const response = await rpcCall(context, "FightFactory", "get_fight_buys", [...encodeU256(fightId), offset.toString(), size.toString()], options);
        attempts.push(...response.attempts);
        const pageItems = decodeFightBuysRpc(response.data);
        items.push(...pageItems);
        if (pageItems.length === 0) break;
        offset += pageItems.length;
      }
      const complete = items.length >= total;
      if (!complete) warnings.push({ code: "RPC_TRAVERSAL_LIMIT", message: `Fight buy enumeration returned ${items.length} of ${total} records.`, source: "starknet-rpc" });
      return result(context, startedAt, "starknet-rpc", items, attempts, complete, warnings);
    },
    async viewerState(fightId, viewer, options = {}) {
      const startedAt = context.now();
      const calldata = [...encodeU256(fightId), normalizeAddress(viewer)];
      const [bought, choice, redeemed, tickets, buy] = await Promise.all([
        rpcCall(context, "FightFactory", "has_bought", calldata, options),
        rpcCall(context, "FightFactory", "user_choice", calldata, options),
        rpcCall(context, "FightFactory", "has_redeemed", calldata, options),
        rpcCall(context, "FightFactory", "preview_strike_tickets", calldata, options),
        rpcCall(context, "FightFactory", "get_fight_buy", calldata, options),
      ]);
      const hasBought = decodeSingleBool(bought.data, "hasBought");
      const choiceIndex = decodeSingleNumber(choice.data, "userChoice");
      const buyData = decodeFightBuyRpc(buy.data);
      return result(context, startedAt, "starknet-rpc", {
        hasBought,
        ...(choiceIndex === 255 ? {} : { choiceIndex }),
        shares: hasBought ? buyData.amount : 0n,
        boughtAt: hasBought ? buyData.boughtAt : 0n,
        hasRedeemed: decodeSingleBool(redeemed.data, "hasRedeemed"),
        isWinner: decodeSingleU256(tickets.data, "strikeTickets") > 0n,
        strikeTickets: decodeSingleU256(tickets.data, "strikeTickets"),
      }, [bought, choice, redeemed, tickets, buy].flatMap((value) => value.attempts));
    },
    async potState(fightId, options = {}) {
      const startedAt = context.now();
      const calldata = encodeU256(fightId);
      const [winner, winners, total, claimed] = await Promise.all([
        rpcCall(context, "FightFactory", "fight_winner_index", calldata, options),
        rpcCall(context, "FightFactory", "winners_count", calldata, options),
        rpcCall(context, "FightFactory", "fight_pot_total", calldata, options),
        rpcCall(context, "FightFactory", "fight_pot_claimed", calldata, options),
      ]);
      const winnerIndex = decodeSingleNumber(winner.data, "winnerIndex");
      return result(context, startedAt, "starknet-rpc", {
        total: decodeSingleU256(total.data, "potTotal"),
        claimed: decodeSingleU256(claimed.data, "potClaimed"),
        ...(winnerIndex === 255 ? {} : { winnerIndex }),
        winnersCount: decodeSingleU256(winners.data, "winnersCount"),
        closed: winnerIndex !== 255,
        settled: winnerIndex !== 255,
      }, [winner, winners, total, claimed].flatMap((value) => value.attempts));
    },
    async winner(fightId, account, options = {}) {
      const startedAt = context.now();
      const response = await rpcCall(context, "FightFactory", "get_fight_winner", [...encodeU256(fightId), normalizeAddress(account)], options);
      const winner = decodeFightWinnerRpc(response.data);
      return result(context, startedAt, "starknet-rpc", winner.winner === normalizeAddress("0") ? undefined : winner, response.attempts);
    },
    async portfolio(account, input = {}, options = {}) {
      const startedAt = context.now();
      if (!context.torii) throw new UnsupportedCapabilityError("portfolio enumeration without Torii");
      const response = await context.torii.model<Record<string, unknown>>({
        model: "FightBuy",
        selection: FIGHT_BUY_SELECTION,
        first: clampPageSize(input.limit, context.budget.pageSize, 20),
        ...(input.cursor ? { after: input.cursor } : {}),
        where: { buyerEQ: normalizeAddress(account) },
      }, options);
      return result(context, startedAt, "torii", {
        items: response.data.edges.map((edge) => mapToriiFightBuy(edge.node)),
        ...(response.data.pageInfo.endCursor ? { cursor: response.data.pageInfo.endCursor } : {}),
        hasMore: response.data.pageInfo.hasNextPage,
      }, response.attempts);
    },
    async portfolioAll(account, options = {}) {
      const startedAt = context.now();
      if (!context.torii) throw new UnsupportedCapabilityError("portfolio enumeration without Torii");
      const response = await readAllToriiModels(context, {
        model: "FightBuy",
        selection: FIGHT_BUY_SELECTION,
        where: { buyerEQ: normalizeAddress(account) },
      }, mapToriiFightBuy, options);
      return result(context, startedAt, "torii", response.items, response.attempts, response.complete, response.warnings);
    },
  };
}

export interface MarketsRepository {
  get(marketId: bigint, options?: RequestOptions): Promise<DataResult<Market>>;
  all(options?: RequestOptions): Promise<DataResult<Market[]>>;
  page(input?: { limit?: number; cursor?: string }, options?: RequestOptions): Promise<DataResult<Page<Market>>>;
  /** @deprecated Use page(). */
  list(input?: { limit?: number; cursor?: string }, options?: RequestOptions): Promise<DataResult<Page<Market>>>;
  catalog(input?: { limit?: number; cursor?: string }, options?: RequestOptions): Promise<DataResult<Page<MarketCatalogItem>>>;
  state(marketId: bigint, outcomeSlotCount: number, conditionId?: bigint, options?: RequestOptions): Promise<DataResult<MarketState>>;
  position(positionId: bigint, options?: RequestOptions): Promise<DataResult<MarketPosition>>;
  conditionalBalance(account: Address, positionId: bigint, options?: RequestOptions): Promise<DataResult<bigint>>;
}

export function createMarketsRepository(context: RepositoryContext): MarketsRepository {
  const get = async (marketId: bigint, options: RequestOptions = {}) => {
    const startedAt = context.now();
    const response = await rpcCall(context, "Markets", "get_market", encodeU256(marketId), options);
    return result(context, startedAt, "starknet-rpc", decodeMarketRpc(response.data), response.attempts);
  };

  const page = async (input: { limit?: number; cursor?: string } = {}, options: RequestOptions = {}) => {
    const startedAt = context.now();
    if (!context.torii) throw new UnsupportedCapabilityError("market enumeration without Torii");
    const response = await context.torii.model<Record<string, unknown>>({
      model: "Market",
      selection: MARKET_SELECTION,
      first: clampPageSize(input.limit, context.budget.pageSize, 20),
      ...(input.cursor ? { after: input.cursor } : {}),
    }, options);
    return result(context, startedAt, "torii", {
      items: response.data.edges.map((edge) => mapToriiMarket(edge.node)),
      ...(response.data.pageInfo.endCursor ? { cursor: response.data.pageInfo.endCursor } : {}),
      hasMore: response.data.pageInfo.hasNextPage,
    }, response.attempts);
  };

  return {
    get,
    async all(options = {}) {
      const startedAt = context.now();
      if (!context.torii) throw new UnsupportedCapabilityError("market enumeration without Torii");
      const response = await readAllToriiModels(context, { model: "Market", selection: MARKET_SELECTION }, mapToriiMarket, options);
      return result(context, startedAt, "torii", response.items, response.attempts, response.complete, response.warnings);
    },
    page,
    list: page,
    async catalog(input = {}, options = {}) {
      const startedAt = context.now();
      const rpcCatalog = async (toriiError?: unknown) => {
        const cursor = input.cursor?.startsWith("rpc:") ? BigInt(input.cursor.slice(4) || "0") : 0n;
        const feed = await createFightsRepository(context).feed({
          cursor,
          ...(input.limit === undefined ? {} : { limit: input.limit }),
        }, options);
        const items = feed.data.items.map((fight): MarketCatalogItem => ({
          market: {
            marketId: fight.marketId,
            creator: normalizeAddress("0"),
            createdAt: fight.marketCreatedAt,
            conditionId: fight.conditionId,
            oracle: fight.oracle,
            outcomeSlotCount: fight.outcomeSlotCount,
            collateralToken: fight.collateralToken,
            startAt: fight.startAt,
            endAt: fight.endAt,
            resolveAt: fight.resolveAt,
            resolvedAt: fight.resolvedAt,
          },
          fight,
          vaultNumerators: fight.vaultNumerators,
          vaultDenominator: fight.vaultDenominator,
        }));
        const warnings: DataWarning[] = [
          ...(toriiError ? [{
            code: "CAPABILITY_FALLBACK",
            message: "Market catalog used the FightFactory aggregate view because Torii was unavailable.",
            source: "starknet-rpc" as const,
          }] : []),
          ...feed.meta.warnings,
        ];
        return result(context, startedAt, "starknet-rpc", {
          items,
          ...(feed.data.cursor === undefined ? {} : { cursor: `rpc:${feed.data.cursor}` }),
          hasMore: feed.data.hasMore,
        }, [
          ...(toriiError ? transportAttemptsFromError(toriiError) : []),
          ...feed.meta.attempts,
        ], false, warnings);
      };
      if (input.cursor?.startsWith("rpc:")) return rpcCatalog();
      try {
        if (!context.torii) throw new UnsupportedCapabilityError("market catalog without Torii");
        const toriiCursor = input.cursor?.startsWith("torii:") ? input.cursor.slice(6) : input.cursor;
        const [marketPage, fights, numerators, denominators] = await Promise.all([
          context.torii.model<Record<string, unknown>>({
            model: "Market",
            selection: MARKET_SELECTION,
            first: clampPageSize(input.limit, context.budget.pageSize, 20),
            ...(toriiCursor ? { after: toriiCursor } : {}),
          }, options),
          readAllToriiModels(context, { model: "Fight", selection: FIGHT_SELECTION }, mapToriiFight, options),
          readAllToriiModels(context, { model: "VaultNumerator", selection: VAULT_NUMERATOR_SELECTION }, (node) => ({
            marketId: scalarBigInt(node.market_id, "market_id"),
            index: scalarNumber(node.index, "index"),
            value: scalarBigInt(node.value, "value"),
          }), options),
          readAllToriiModels(context, { model: "VaultDenominator", selection: VAULT_DENOMINATOR_SELECTION }, (node) => ({
            marketId: scalarBigInt(node.market_id, "market_id"),
            value: scalarBigInt(node.value, "value"),
          }), options),
        ]);

        const fightByMarket = new Map(fights.items.map((fight) => [fight.marketId.toString(), fight]));
        const numeratorByMarket = new Map<string, Map<number, bigint>>();
        for (const numerator of numerators.items) {
          const key = numerator.marketId.toString();
          const values = numeratorByMarket.get(key) ?? new Map<number, bigint>();
          values.set(numerator.index, numerator.value);
          numeratorByMarket.set(key, values);
        }
        const denominatorByMarket = new Map(denominators.items.map((denominator) => [denominator.marketId.toString(), denominator.value]));
        const items = marketPage.data.edges.map((edge): MarketCatalogItem => {
          const market = mapToriiMarket(edge.node);
          const key = market.marketId.toString();
          const fight = fightByMarket.get(key);
          return {
            market,
            ...(fight ? { fight } : {}),
            vaultNumerators: Array.from(
              { length: market.outcomeSlotCount },
              (_, index) => numeratorByMarket.get(key)?.get(index) ?? 0n,
            ),
            vaultDenominator: denominatorByMarket.get(key) ?? 0n,
          };
        });
        const warnings = [...fights.warnings, ...numerators.warnings, ...denominators.warnings];
        return result(context, startedAt, "torii", {
          items,
          ...(marketPage.data.pageInfo.endCursor ? { cursor: `torii:${marketPage.data.pageInfo.endCursor}` } : {}),
          hasMore: marketPage.data.pageInfo.hasNextPage,
        }, [
          ...marketPage.attempts,
          ...fights.attempts,
          ...numerators.attempts,
          ...denominators.attempts,
        ], fights.complete && numerators.complete && denominators.complete, warnings);
      } catch (error) {
        try {
          return await rpcCatalog(error);
        } catch (rpcError) {
          throw new AllSourcesFailedError("markets.catalog", [
            ...transportAttemptsFromError(error),
            ...transportAttemptsFromError(rpcError),
          ]);
        }
      }
    },
    async state(marketId, outcomeSlotCount, conditionId, options = {}) {
      const startedAt = context.now();
      if (!Number.isSafeInteger(outcomeSlotCount) || outcomeSlotCount < 2 || outcomeSlotCount > 255) {
        throw new ValidationError("outcomeSlotCount must be between 2 and 255.");
      }
      const marketResult = await get(marketId, options);
      const vaults = await mapConcurrent(Array.from({ length: outcomeSlotCount }, (_, index) => index), context.budget.maxConcurrency, async (index) => {
        const response = await rpcCall(context, "Markets", "get_vault_numerator", [...encodeU256(marketId), index.toString()], options);
        return { value: decodeSingleU256(response.data.slice(-2), "vaultNumerator"), attempts: response.attempts };
      });
      const denominator = await rpcCall(context, "Markets", "get_vault_denominator", encodeU256(marketId), options);
      const condition = conditionId ?? marketResult.data.conditionId;
      const payouts = await mapConcurrent(Array.from({ length: outcomeSlotCount }, (_, index) => index), context.budget.maxConcurrency, async (index) => {
        const response = await rpcCall(context, "ConditionalTokens", "get_payout_numerator", [...encodeU256(condition), index.toString()], options);
        return { value: decodeSingleU256(response.data.slice(-2), "payoutNumerator"), attempts: response.attempts };
      });
      const payoutDenominator = await rpcCall(context, "ConditionalTokens", "get_payout_denominator", encodeU256(condition), options);
      return result(context, startedAt, "starknet-rpc", {
        market: marketResult.data,
        vaultNumerators: vaults.map((value) => value.value),
        vaultDenominator: decodeSingleU256(denominator.data.slice(-2), "vaultDenominator"),
        payoutNumerators: payouts.map((value) => value.value),
        payoutDenominator: decodeSingleU256(payoutDenominator.data.slice(-2), "payoutDenominator"),
      }, [
        ...marketResult.meta.attempts,
        ...vaults.flatMap((value) => value.attempts),
        ...denominator.attempts,
        ...payouts.flatMap((value) => value.attempts),
        ...payoutDenominator.attempts,
      ]);
    },
    async position(positionId, options = {}) {
      const startedAt = context.now();
      const response = await rpcCall(context, "Markets", "get_market_position", encodeU256(positionId), options);
      const values = response.data;
      if (values.length < 4) throw new ValidationError("Market position response is incomplete.");
      return result(context, startedAt, "starknet-rpc", {
        marketId: decodeSingleU256(values.slice(0, 2), "position.marketId"),
        positionId,
        value: decodeSingleU256(values.slice(-2), "position.value"),
      }, response.attempts);
    },
    async conditionalBalance(account, positionId, options = {}) {
      const startedAt = context.now();
      const response = await rpcCall(context, "ConditionalTokens", "balance_of", [normalizeAddress(account), ...encodeU256(positionId)], options);
      return result(context, startedAt, "starknet-rpc", decodeSingleU256(response.data, "conditionalBalance"), response.attempts);
    },
  };
}

export interface TokensRepository {
  callsBalance(account: Address, options?: RequestOptions): Promise<DataResult<bigint>>;
  callsAllowance(owner: Address, spender?: Address, options?: RequestOptions): Promise<DataResult<bigint>>;
  strikeTicketBalance(account: Address, fightId: bigint, options?: RequestOptions): Promise<DataResult<bigint>>;
  vaultPositionBalance(account: Address, positionId: bigint, options?: RequestOptions): Promise<DataResult<bigint>>;
  isApprovedForAll(token: "StrikeTickets" | "VaultPositions" | "ConditionalTokens", owner: Address, operator: Address, options?: RequestOptions): Promise<DataResult<boolean>>;
}

export function createTokensRepository(context: RepositoryContext): TokensRepository {
  const balance = async (contract: "CALLS" | "StrikeTickets" | "VaultPositions", account: Address, tokenId: bigint | undefined, operation: string, options: RequestOptions) => {
    const startedAt = context.now();
    const calldata = tokenId === undefined ? [normalizeAddress(account)] : [normalizeAddress(account), ...encodeU256(tokenId)];
    const response = await rpcCall(context, contract, "balance_of", calldata, options);
    return result(context, startedAt, "starknet-rpc", decodeSingleU256(response.data, operation), response.attempts);
  };
  return {
    callsBalance(account, options = {}) { return balance("CALLS", account, undefined, "callsBalance", options); },
    async callsAllowance(owner, spender = context.network.contracts.Markets, options = {}) {
      const startedAt = context.now();
      const response = await rpcCall(context, "CALLS", "allowance", [normalizeAddress(owner), normalizeAddress(spender)], options);
      return result(context, startedAt, "starknet-rpc", decodeSingleU256(response.data, "callsAllowance"), response.attempts);
    },
    strikeTicketBalance(account, fightId, options = {}) { return balance("StrikeTickets", account, fightId, "strikeTicketBalance", options); },
    vaultPositionBalance(account, positionId, options = {}) { return balance("VaultPositions", account, positionId, "vaultPositionBalance", options); },
    async isApprovedForAll(token, owner, operator, options = {}) {
      const startedAt = context.now();
      const response = await rpcCall(context, token, "is_approved_for_all", [normalizeAddress(owner), normalizeAddress(operator)], options);
      return result(context, startedAt, "starknet-rpc", decodeSingleBool(response.data, "isApprovedForAll"), response.attempts);
    },
  };
}

export interface GachaRepository {
  pool(fightId: bigint, options?: RequestOptions): Promise<DataResult<GachaPoolState>>;
  poolStates(fightIds: readonly bigint[], options?: RequestOptions): Promise<DataResult<GachaPoolState[]>>;
  user(fightId: bigint, account: Address, options?: RequestOptions): Promise<DataResult<GachaUserState>>;
  userStates(fightIds: readonly bigint[], account: Address, options?: RequestOptions): Promise<DataResult<GachaUserStates>>;
  availableTokenIds(fightId: bigint, input?: { cursor?: bigint; limit?: number }, options?: RequestOptions): Promise<DataResult<Page<bigint, bigint>>>;
  availableTokenIdsAll(fightId: bigint, options?: RequestOptions): Promise<DataResult<bigint[]>>;
  isAdmin(account: Address, options?: RequestOptions): Promise<DataResult<boolean>>;
  vrfAddress(options?: RequestOptions): Promise<DataResult<Address>>;
}

export function createGachaRepository(context: RepositoryContext, tokens: TokensRepository): GachaRepository {
  return {
    async pool(fightId, options = {}) {
      const startedAt = context.now();
      const id = encodeU256(fightId);
      const supportsAggregate = context.capabilities.has("gachaPoolAggregate")
        || await context.capabilities.probe("gachaPoolAggregate", options.signal);
      if (supportsAggregate) {
        const response = await rpcCall(context, "Gacha", "get_pool_state", id, options);
        return result(
          context,
          startedAt,
          "starknet-rpc",
          decodeGachaPoolStateRpc(response.data),
          response.attempts,
          true,
          [],
          response.blockNumber,
        );
      }
      const [open, size, rarities] = await Promise.all([
        rpcCall(context, "Gacha", "pool_open", id, options),
        rpcCall(context, "Gacha", "pool_size", id, options),
        mapConcurrent(Array.from({ length: 7 }, (_, rarity) => rarity), context.budget.maxConcurrency, async (rarity) => {
          const [expected, registered, available] = await Promise.all([
            rpcCall(context, "Gacha", "expected_count", [...id, rarity.toString()], options),
            rpcCall(context, "Gacha", "pool_registered_count", [...id, rarity.toString()], options),
            rpcCall(context, "Gacha", "pool_available_count", [...id, rarity.toString()], options),
          ]);
          return {
            data: {
              rarity,
              expected: decodeSingleU256(expected.data, "expectedCount"),
              registered: decodeSingleU256(registered.data, "registeredCount"),
              available: decodeSingleU256(available.data, "availableCount"),
            },
            attempts: [...expected.attempts, ...registered.attempts, ...available.attempts],
          };
        }),
      ]);
      return result(context, startedAt, "starknet-rpc", {
        fightId,
        open: decodeSingleBool(open.data, "poolOpen"),
        size: decodeSingleU256(size.data, "poolSize"),
        rarities: rarities.map((value) => value.data),
      }, [...open.attempts, ...size.attempts, ...rarities.flatMap((value) => value.attempts)], false, [{
        code: "CAPABILITY_FALLBACK",
        message: "Gacha pool state used bounded singleton views because the aggregate view is unavailable.",
        source: "starknet-rpc",
      }]);
    },
    async poolStates(fightIds, options = {}) {
      const startedAt = context.now();
      const budget = resolveRequestBudget(context.budget, options);
      const unique = Array.from(new Set(fightIds.map((fightId) => {
        if (fightId <= 0n) throw new ValidationError("fightIds must contain positive identifiers.");
        return fightId.toString();
      }))).map(BigInt);
      if (unique.length === 0) return result(context, startedAt, "derived", [], []);
      if (unique.length > budget.maxRpcItems) {
        throw new ValidationError(`fightIds exceeds the ${budget.maxRpcItems} RPC item budget.`);
      }
      const supported = context.capabilities.has("gachaPoolAggregate")
        || await context.capabilities.probe("gachaPoolAggregate", options.signal);
      const attempts: SourceAttempt[] = [];
      const states: GachaPoolState[] = [];
      if (supported) {
        for (let offset = 0; offset < unique.length; offset += 20) {
          const ids = unique.slice(offset, offset + 20);
          const response = await rpcCall(context, "Gacha", "get_pool_states", [
            ids.length.toString(),
            ...ids.flatMap(encodeU256),
          ], options);
          attempts.push(...response.attempts);
          states.push(...decodeGachaPoolStatesRpc(response.data));
        }
        const byId = new Map(states.map((state) => [state.fightId.toString(), state]));
        return result(context, startedAt, "starknet-rpc", unique.flatMap((fightId) => {
          const state = byId.get(fightId.toString());
          return state ? [state] : [];
        }), attempts, states.length === unique.length, states.length === unique.length ? [] : [{
          code: "PARTIAL_AGGREGATE",
          message: `Gacha pool batch returned ${states.length} of ${unique.length} requested states.`,
          source: "starknet-rpc",
        }]);
      }
      const fallback = await mapConcurrent(unique, budget.maxConcurrency, (fightId) =>
        createGachaRepository(context, tokens).pool(fightId, options));
      return result(context, startedAt, "starknet-rpc", fallback.map((value) => value.data), fallback.flatMap((value) => value.meta.attempts), false, [{
        code: "CAPABILITY_FALLBACK",
        message: "Gacha pool batches used bounded singleton views because get_pool_states is unavailable.",
        source: "starknet-rpc",
      }]);
    },
    async user(fightId, account, options = {}) {
      const startedAt = context.now();
      const [escrow, nonce, tickets] = await Promise.all([
        rpcCall(context, "Gacha", "escrowed_token", [...encodeU256(fightId), normalizeAddress(account)], options),
        rpcCall(context, "Gacha", "get_strike_nonce", [normalizeAddress(account)], options),
        tokens.strikeTicketBalance(account, fightId, options),
      ]);
      const tokenId = decodeSingleU256(escrow.data, "escrowedToken");
      return result(context, startedAt, "starknet-rpc", {
        fightId,
        user: normalizeAddress(account),
        ...(tokenId === 0n ? {} : { escrowedTokenId: tokenId }),
        strikeNonce: scalarBigInt(nonce.data[0], "strikeNonce"),
        ticketBalance: tickets.data,
      }, [...escrow.attempts, ...nonce.attempts, ...tickets.meta.attempts]);
    },
    async userStates(fightIds, account, options = {}) {
      const startedAt = context.now();
      const budget = resolveRequestBudget(context.budget, options);
      const ids = Array.from(new Set(fightIds.map((fightId) => {
        if (fightId <= 0n) throw new ValidationError("fightIds must contain positive identifiers.");
        return fightId.toString();
      }))).map(BigInt);
      if (ids.length > budget.maxRpcItems) {
        throw new ValidationError(`fightIds exceeds the ${budget.maxRpcItems} RPC item budget.`);
      }
      const user = normalizeAddress(account);
      if (ids.length === 0) return result(context, startedAt, "derived", {
        user,
        strikeNonce: 0n,
        states: [],
      }, []);
      const supported = context.capabilities.has("gachaUserStates")
        || await context.capabilities.probe("gachaUserStates", options.signal);
      if (supported) {
        const attempts: SourceAttempt[] = [];
        const states: GachaFightUserState[] = [];
        let strikeNonce = 0n;
        for (let offset = 0; offset < ids.length; offset += 20) {
          const batch = ids.slice(offset, offset + 20);
          const response = await rpcCall(context, "Gacha", "get_user_states", [
            batch.length.toString(),
            ...batch.flatMap(encodeU256),
            user,
          ], options);
          attempts.push(...response.attempts);
          const decoded = decodeGachaUserStatesRpc(response.data, user);
          if (offset === 0) strikeNonce = decoded.strikeNonce;
          states.push(...decoded.states);
        }
        const byId = new Map(states.map((state) => [state.fightId.toString(), state]));
        const ordered = ids.flatMap((fightId) => {
          const state = byId.get(fightId.toString());
          return state ? [state] : [];
        });
        return result(context, startedAt, "starknet-rpc", {
          user,
          strikeNonce,
          states: ordered,
        }, attempts, ordered.length === ids.length, ordered.length === ids.length ? [] : [{
          code: "PARTIAL_AGGREGATE",
          message: `Gacha account-state batches returned ${ordered.length} of ${ids.length} requested states.`,
          source: "starknet-rpc",
        }]);
      }
      const states = await mapConcurrent(ids, budget.maxConcurrency, async (fightId) => {
        const [userState, poolState] = await Promise.all([
          createGachaRepository(context, tokens).user(fightId, account, options),
          createGachaRepository(context, tokens).pool(fightId, options),
        ]);
        return { data: { ...userState.data, pool: poolState.data }, attempts: [...userState.meta.attempts, ...poolState.meta.attempts] };
      });
      const strikeNonce = states[0]?.data.strikeNonce ?? 0n;
      return result(context, startedAt, "starknet-rpc", {
        user,
        strikeNonce,
        states: states.map((value) => value.data),
      }, states.flatMap((value) => value.attempts), false, [{
        code: "CAPABILITY_FALLBACK",
        message: "Gacha account states used singleton RPC views because the batch view is unavailable.",
        source: "starknet-rpc",
      }]);
    },
    async availableTokenIds(fightId, input = {}, options = {}) {
      const startedAt = context.now();
      const supported = context.capabilities.has("gachaAvailableTokenIds") || await context.capabilities.probe("gachaAvailableTokenIds", options.signal);
      if (!supported) throw new UnsupportedCapabilityError("gacha available token ID pagination");
      const cursor = input.cursor ?? 0n;
      const size = clampPageSize(input.limit, 100, 100);
      const response = await rpcCall(context, "Gacha", "get_available_token_ids", [
        ...encodeU256(fightId), ...encodeU256(cursor), size.toString(),
      ], options);
      const values = response.data;
      const count = Number(BigInt(values[0] ?? "0"));
      const items = Array.from({ length: count }, (_, index) => decodeSingleU256(values.slice(1 + index * 2, 3 + index * 2), "availableTokenId"));
      const next = decodeSingleU256(values.slice(1 + count * 2, 3 + count * 2), "nextOffset");
      const total = decodeSingleU256(values.slice(3 + count * 2, 5 + count * 2), "total");
      return result(context, startedAt, "starknet-rpc", { items, cursor: next, hasMore: next < total }, response.attempts, true, [{
        code: "NON_SNAPSHOT_PAGINATION",
        message: "Gacha available-token pages can shift while strikes swap-remove pool entries.",
        source: "starknet-rpc",
      }]);
    },
    async availableTokenIdsAll(fightId, options = {}) {
      const startedAt = context.now();
      const budget = resolveRequestBudget(context.budget, options);
      const attempts: SourceAttempt[] = [];
      const warnings: DataWarning[] = [];
      const items: bigint[] = [];
      let cursor = 0n;
      let exhausted = false;
      for (let pageIndex = 0; pageIndex < budget.maxRpcPages && items.length < budget.maxRpcItems; pageIndex += 1) {
        const response = await createGachaRepository(context, tokens).availableTokenIds(fightId, { cursor, limit: Math.min(100, budget.maxRpcItems - items.length) }, options);
        attempts.push(...response.meta.attempts);
        warnings.push(...response.meta.warnings);
        items.push(...response.data.items);
        if (!response.data.hasMore) { exhausted = true; break; }
        const next = response.data.cursor ?? cursor;
        if (next === cursor || response.data.items.length === 0) {
          warnings.push({ code: "RPC_CURSOR_STALLED", message: `Gacha token pagination stopped at cursor ${cursor}.`, source: "starknet-rpc" });
          break;
        }
        cursor = next;
      }
      if (!exhausted) warnings.push({ code: "RPC_TRAVERSAL_LIMIT", message: "Gacha token enumeration stopped before source exhaustion.", source: "starknet-rpc" });
      return result(context, startedAt, "starknet-rpc", items, attempts, exhausted, warnings);
    },
    async isAdmin(account, options = {}) {
      const startedAt = context.now();
      const response = await rpcCall(context, "Gacha", "is_admin", [normalizeAddress(account)], options);
      return result(context, startedAt, "starknet-rpc", decodeSingleBool(response.data, "gacha.isAdmin"), response.attempts);
    },
    async vrfAddress(options = {}) {
      const startedAt = context.now();
      const response = await rpcCall(context, "Gacha", "vrf_address", [], options);
      const value = response.data[0];
      if (!value) throw new ValidationError("Gacha VRF response was empty.");
      return result(context, startedAt, "starknet-rpc", normalizeAddress(value), response.attempts);
    },
  };
}

export interface FightEventsRepository {
  get(eventName: string, input?: { seasonId?: bigint; fightIds?: readonly bigint[]; viewer?: Address; expectedFightCount?: number; cursor?: bigint; limit?: number; now?: bigint }, options?: RequestOptions): Promise<DataResult<FightEvent | undefined>>;
  all(input?: { viewer?: Address; now?: bigint }, options?: RequestOptions): Promise<DataResult<FightEvent[]>>;
  page(input?: { limit?: number; cursor?: bigint; viewer?: Address; now?: bigint }, options?: RequestOptions): Promise<DataResult<Page<FightEvent, bigint>>>;
  /** @deprecated Use page(). */
  list(input?: { limit?: number; cursor?: bigint; viewer?: Address; now?: bigint }, options?: RequestOptions): Promise<DataResult<Page<FightEvent, bigint>>>;
}

export function createFightEventsRepository(context: RepositoryContext, fights: FightsRepository): FightEventsRepository {
  const group = (items: FightFeedItem[], now: bigint): FightEvent[] => {
    const groups = new Map<string, FightFeedItem[]>();
    for (const fight of items) {
      const key = `${fight.seasonId}:${fight.eventName}`;
      groups.set(key, [...(groups.get(key) ?? []), fight]);
    }
    return Array.from(groups.values()).map((eventFights): FightEvent => {
      const states = new Set(eventFights.map((fight) => {
        if (fight.pot.settled) return "settled" as const;
        if (fight.pot.closed || now >= fight.endAt) return "closed" as const;
        if (now >= fight.startAt) return "open" as const;
        return "upcoming" as const;
      }));
      const first = eventFights[0];
      if (!first) throw new ValidationError("Fight event group is empty.");
      return { seasonId: first.seasonId, eventName: first.eventName, fights: eventFights, lifecycle: states.size === 1 ? (states.values().next().value ?? "mixed") : "mixed" };
    });
  };
  const page = async (input: { limit?: number; cursor?: bigint; viewer?: Address; now?: bigint } = {}, options: RequestOptions = {}) => {
    const startedAt = context.now();
    const response = await fights.feed(input, options);
    return result(context, startedAt, "derived", {
      items: group(response.data.items, input.now ?? BigInt(Math.floor(context.now() / 1_000))),
      ...(response.data.cursor === undefined ? {} : { cursor: response.data.cursor }),
      hasMore: response.data.hasMore,
    }, response.meta.attempts, response.meta.complete, response.meta.warnings);
  };
  return {
    async get(eventName, input = {}, options = {}) {
      const startedAt = context.now();
      const budget = resolveRequestBudget(context.budget, options);
      const attempts: SourceAttempt[] = [];
      const warnings: DataWarning[] = [];
      const matches: FightFeedItem[] = [];
      if (input.fightIds) {
        const response = await fights.feedMany(input.fightIds, input.viewer ? { viewer: input.viewer } : {}, options);
        attempts.push(...response.meta.attempts);
        warnings.push(...response.meta.warnings);
        matches.push(...response.data.filter((fight) =>
          fight.eventName === eventName && (input.seasonId === undefined || fight.seasonId === input.seasonId)));
        const expected = input.expectedFightCount ?? input.fightIds.length;
        const complete = response.meta.complete && matches.length >= expected;
        if (!complete) warnings.push({
          code: "PARTIAL_AGGREGATE",
          message: `Event lookup matched ${matches.length} of ${expected} expected fights.`,
          source: "derived",
        });
        return result(
          context,
          startedAt,
          "derived",
          group(matches, input.now ?? BigInt(Math.floor(context.now() / 1_000)))[0],
          attempts,
          complete,
          warnings,
        );
      }
      let cursor = input.cursor ?? 0n;
      let exhausted = false;
      const expected = input.expectedFightCount;
      for (let index = 0; index < budget.maxRpcPages && matches.length < (expected ?? Number.POSITIVE_INFINITY); index += 1) {
        const response = await fights.feed({
          cursor,
          limit: Math.min(input.limit ?? 20, 20),
          ...(input.viewer === undefined ? {} : { viewer: input.viewer }),
        }, options);
        attempts.push(...response.meta.attempts);
        warnings.push(...response.meta.warnings);
        matches.push(...response.data.items.filter((fight) =>
          fight.eventName === eventName && (input.seasonId === undefined || fight.seasonId === input.seasonId)));
        if (!response.data.hasMore) { exhausted = true; break; }
        const next = response.data.cursor ?? 0n;
        if (next === 0n || next === cursor) break;
        cursor = next;
      }
      const grouped = group(matches, input.now ?? BigInt(Math.floor(context.now() / 1_000)))[0];
      const complete = expected === undefined ? exhausted : matches.length >= expected;
      if (!complete) warnings.push({
        code: "RPC_PAGE_LIMIT",
        message: expected === undefined
          ? "Event lookup stopped before the fight feed was exhausted."
          : `Event lookup found ${matches.length} of ${expected} expected fights.`,
        source: "starknet-rpc",
      });
      return result(context, startedAt, "derived", grouped, attempts, complete, warnings);
    },
    async all(input = {}, options = {}) {
      const startedAt = context.now();
      const response = await fights.feedAll({ ...(input.viewer ? { viewer: input.viewer } : {}) }, options);
      return result(context, startedAt, "derived", group(response.data, input.now ?? BigInt(Math.floor(context.now() / 1_000))), response.meta.attempts, response.meta.complete, response.meta.warnings);
    },
    page,
    list: page,
  };
}
