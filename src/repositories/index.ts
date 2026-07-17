import { createDataResult, mapConcurrent, resolveRequestBudget } from "../core/request.js";
import { clampPageSize, encodeU256, normalizeAddress, normalizeU256, sameAddress } from "../core/codecs.js";
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
  normalizeFightViewerState,
  scalarBigInt,
  scalarNumber,
} from "../core/decoders.js";
import { AllSourcesFailedError, UnsupportedCapabilityError, ValidationError } from "../core/errors.js";
import type { CapabilityRegistry } from "../network.js";
import type { RpcTransport, ToriiTransport, TransportResult } from "../transports/index.js";
import { transportAttemptsFromError } from "../transports/index.js";
import { readAllToriiModels } from "../transports/torii-models.js";
import { readToriiFightSnapshots } from "./torii-fights.js";
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
  IndexedTokenBalance,
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
const PAYOUT_NUMERATOR_SELECTION = ["condition_id", "index", "value"] as const;
const PAYOUT_DENOMINATOR_SELECTION = ["condition_id", "value"] as const;
const MARKET_POSITION_SELECTION = ["position_id", "market_id", "index"] as const;

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
    if (context.torii) {
      try {
        const response = await context.torii.model<Record<string, unknown>>({
          model: "Fighter",
          selection: FIGHTER_SELECTION,
          first: 1,
          where: { fighter_idEQ: normalizeU256(fighterId, "fighterId") },
        }, options);
        const node = response.data.edges[0]?.node;
        if (node) return result(context, startedAt, "torii", mapToriiFighter(node), response.attempts);
      } catch {
        // The exact contract view is the bounded fallback when Torii is unavailable.
      }
    }
    const response = await rpcCall(context, "FighterRegistry", "get_fighter", calldata, options);
    return result(context, startedAt, "starknet-rpc", decodeFighterRpc(response.data), response.attempts, true, [], response.blockNumber);
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
      const attempts: SourceAttempt[] = [];
      if (context.torii) {
        try {
          const response = await readAllToriiModels(context, {
            model: "Fighter",
            selection: FIGHTER_SELECTION,
            where: { fighter_idIN: unique.map((fighterId) => normalizeU256(fighterId, "fighterId")) },
          }, mapToriiFighter, options);
          const byId = new Map(response.items.map((fighter) => [fighter.fighterId.toString(), fighter]));
          const ordered = unique.flatMap((fighterId) => {
            const fighter = byId.get(fighterId.toString());
            return fighter ? [fighter] : [];
          });
          return result(
            context,
            startedAt,
            "torii",
            ordered,
            response.attempts,
            response.complete && ordered.length === unique.length,
            response.warnings,
          );
        } catch (error) {
          attempts.push(...transportAttemptsFromError(error));
        }
      }
      const supportsBatch = context.capabilities.has("fighterBatch") || await context.capabilities.probe("fighterBatch", options.signal);
      if (supportsBatch) {
        const fighters: Fighter[] = [];
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
        [...attempts, ...values.flatMap((value) => value.meta.attempts)],
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
  getMany(fightIds: readonly bigint[], options?: RequestOptions): Promise<DataResult<Fight[]>>;
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
    if (context.torii) {
      try {
        const response = await context.torii.model<Record<string, unknown>>({
          model: "Fight",
          selection: FIGHT_SELECTION,
          first: 1,
          where: { fight_idEQ: normalizeU256(fightId, "fightId") },
        }, options);
        const node = response.data.edges[0]?.node;
        if (node) return result(context, startedAt, "torii", mapToriiFight(node), response.attempts);
      } catch {
        // The exact RPC view is the bounded fallback for an unavailable Torii read.
      }
    }
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
          ...(input.seasonId === undefined ? {} : { where: { season_idEQ: normalizeU256(input.seasonId, "seasonId") } }),
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

    const supportsFeed = context.capabilities.has("fightFeed") || await context.capabilities.probe("fightFeed", options.signal);
    if (!supportsFeed) throw new UnsupportedCapabilityError("fight pagination without Torii or get_fight_feed");
    const feed = await createFightsRepository(context).feed({
      limit: clampPageSize(input.limit, 20, 20),
      ...(input.cursor ? { cursor: BigInt(input.cursor) } : {}),
    }, options);
    attempts.push(...feed.meta.attempts);
    return result(context, startedAt, "starknet-rpc", {
      items: input.seasonId === undefined ? feed.data.items : feed.data.items.filter((fight) => fight.seasonId === input.seasonId),
      ...(feed.data.cursor === undefined ? {} : { cursor: feed.data.cursor.toString() }),
      hasMore: feed.data.hasMore,
    }, attempts, feed.meta.complete, feed.meta.warnings);
  };

  return {
    get,
    async getMany(fightIds, options = {}) {
      const startedAt = context.now();
      const unique = Array.from(new Set(fightIds.map(String))).map(BigInt);
      if (unique.length === 0) return result(context, startedAt, "torii", [], []);
      if (context.torii) {
        try {
          const response = await readAllToriiModels(context, {
            model: "Fight",
            selection: FIGHT_SELECTION,
            where: { fight_idIN: unique.map((fightId) => normalizeU256(fightId, "fightId")) },
          }, mapToriiFight, options);
          const byId = new Map(response.items.map((fight) => [fight.fightId.toString(), fight]));
          const ordered = unique.flatMap((fightId) => {
            const fight = byId.get(fightId.toString());
            return fight ? [fight] : [];
          });
          return result(context, startedAt, "torii", ordered, response.attempts, response.complete && ordered.length === unique.length, response.warnings);
        } catch {
          // The aggregate fight snapshot view is the only RPC fallback.
        }
      }
      const snapshots = await createFightsRepository(context).feedMany(unique, {}, options);
      return result(context, startedAt, snapshots.meta.source, snapshots.data, snapshots.meta.attempts, snapshots.meta.complete, snapshots.meta.warnings);
    },
    async all(input = {}, options = {}) {
      const startedAt = context.now();
      const attempts: SourceAttempt[] = [];
      const warnings: DataWarning[] = [];
      if (context.torii) {
        try {
          const response = await readAllToriiModels(context, {
            model: "Fight",
            selection: FIGHT_SELECTION,
            ...(input.seasonId === undefined ? {} : { where: { season_idEQ: normalizeU256(input.seasonId, "seasonId") } }),
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
      throw new UnsupportedCapabilityError("fight enumeration without Torii or get_fight_feed");
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
        throw new ValidationError(`fightIds exceeds the ${budget.maxRpcItems} item budget.`);
      }

      const viewer = normalizeAddress(input.viewer ?? "0x0");
      if (context.torii) {
        try {
          return await readToriiFightSnapshots(context, unique, viewer, options);
        } catch (toriiError) {
          const supported = context.capabilities.has("fightFeedByIds")
            || await context.capabilities.probe("fightFeedByIds", options.signal);
          if (!supported) throw new AllSourcesFailedError("fights.feedMany", transportAttemptsFromError(toriiError));
          const rows: FightFeedItem[] = [];
          const rpcAttempts: SourceAttempt[] = [];
          for (let offset = 0; offset < unique.length; offset += 20) {
            const ids = unique.slice(offset, offset + 20);
            const response = await rpcCall(context, "FightFactory", "get_fight_feed_by_ids", [
              ids.length.toString(),
              ...ids.flatMap(encodeU256),
              viewer,
            ], options);
            rpcAttempts.push(...response.attempts);
            rows.push(...decodeFightFeedRpc(response.data));
          }
          const byId = new Map(rows.map((row) => [row.fightId.toString(), row]));
          const ordered = unique.flatMap((fightId) => {
            const row = byId.get(fightId.toString());
            return row ? [row] : [];
          });
          return result(context, startedAt, "starknet-rpc", ordered, [
            ...transportAttemptsFromError(toriiError),
            ...rpcAttempts,
          ], false, [{
            code: "TORII_FALLBACK",
            message: "Exact fight snapshots used the bounded aggregate RPC view because Torii was unavailable.",
            source: "starknet-rpc",
          }]);
        }
      }

      const supported = context.capabilities.has("fightFeedByIds")
        || await context.capabilities.probe("fightFeedByIds", options.signal);
      if (!supported) throw new UnsupportedCapabilityError("exact fight snapshots without Torii or get_fight_feed_by_ids");
      const rows: FightFeedItem[] = [];
      const rpcAttempts: SourceAttempt[] = [];
      for (let offset = 0; offset < unique.length; offset += 20) {
        const ids = unique.slice(offset, offset + 20);
        const response = await rpcCall(context, "FightFactory", "get_fight_feed_by_ids", [
          ids.length.toString(),
          ...ids.flatMap(encodeU256),
          viewer,
        ], options);
        rpcAttempts.push(...response.attempts);
        rows.push(...decodeFightFeedRpc(response.data));
      }
      const byId = new Map(rows.map((row) => [row.fightId.toString(), row]));
      const ordered = unique.flatMap((fightId) => {
        const row = byId.get(fightId.toString());
        return row ? [row] : [];
      });
      return result(context, startedAt, "starknet-rpc", ordered, rpcAttempts, ordered.length === unique.length);
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
      return result(context, startedAt, attempts.some((attempt) => attempt.source === "starknet-rpc") ? "starknet-rpc" : "torii", items, attempts, complete && exhausted, warnings);
    },
    async feed(input = {}, options = {}) {
      const startedAt = context.now();
      const size = clampPageSize(input.limit, 20, 20);
      const viewer = normalizeAddress(input.viewer ?? "0x0");
      if (context.torii) {
        try {
          const start = input.cursor ?? 0n;
          const response = await context.torii.model<Record<string, unknown>>({
            model: "Fight",
            selection: FIGHT_SELECTION,
            first: size,
            ...(start > 0n ? { where: { fight_idLTE: normalizeU256(start, "fight cursor") } } : {}),
            order: { field: "FIGHT_ID", direction: "DESC" },
          }, options);
          const ids = response.data.edges.map((edge) => scalarBigInt(edge.node.fight_id, "fight_id"));
          const snapshots = await readToriiFightSnapshots(context, ids, viewer, options);
          const oldest = ids.at(-1) ?? 0n;
          const cursor = oldest > 1n ? oldest - 1n : 0n;
          return result(context, startedAt, "torii", {
            items: snapshots.data,
            cursor,
            hasMore: response.data.pageInfo.hasNextPage && cursor > 0n,
          }, [...response.attempts, ...snapshots.meta.attempts], snapshots.meta.complete, snapshots.meta.warnings);
        } catch {
          // Only the aggregate feed view may be used as an RPC fallback.
        }
      }
      const supported = context.capabilities.has("fightFeed") || await context.capabilities.probe("fightFeed", options.signal);
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
      throw new UnsupportedCapabilityError("fight feed without Torii or get_fight_feed");
    },
    async accountFeed(account, input = {}, options = {}) {
      const startedAt = context.now();
      if (context.torii) {
        try {
          const portfolio = await createFightsRepository(context).portfolioAll(account, options);
          const size = clampPageSize(input.limit, 20, 20);
          const ordered = portfolio.data
            .slice()
            .sort((left, right) => left.fightId === right.fightId ? 0 : left.fightId > right.fightId ? -1 : 1)
            .filter((buy) => input.cursor === undefined || input.cursor === 0n || buy.fightId <= input.cursor);
          const buys = ordered.slice(0, size);
          const snapshots = await readToriiFightSnapshots(context, buys.map((buy) => buy.fightId), normalizeAddress(account), options);
          const hasMore = ordered.length > buys.length;
          const oldest = buys.at(-1)?.fightId ?? 0n;
          return result(context, startedAt, "torii", {
            items: snapshots.data,
            ...(hasMore && oldest > 1n ? { cursor: oldest - 1n } : {}),
            hasMore,
          }, [...portfolio.meta.attempts, ...snapshots.meta.attempts], portfolio.meta.complete && snapshots.meta.complete, [...portfolio.meta.warnings, ...snapshots.meta.warnings]);
        } catch {
          // Only the aggregate account feed may be used as an RPC fallback.
        }
      }
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
      return result(context, startedAt, attempts.some((attempt) => attempt.source === "starknet-rpc") ? "starknet-rpc" : "torii", items, attempts, exhausted, warnings);
    },
    async buys(fightId, input = {}, options = {}) {
      const startedAt = context.now();
      const offset = input.offset ?? 0;
      if (!Number.isSafeInteger(offset) || offset < 0) throw new ValidationError("offset must be a non-negative safe integer.");
      const size = clampPageSize(input.limit, 100, 100);
      const attempts: SourceAttempt[] = [];
      if (context.torii) {
        try {
          const budget = resolveRequestBudget(context.budget, options);
          const requestedEnd = offset + size;
          const fetchSize = Math.min(requestedEnd, budget.maxToriiItems);
          const response = await context.torii.model<Record<string, unknown>>({
            model: "FightBuy",
            selection: FIGHT_BUY_SELECTION,
            first: Math.max(1, fetchSize),
            where: { fight_idEQ: normalizeU256(fightId, "fightId") },
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
        } catch (error) {
          attempts.push(...transportAttemptsFromError(error));
        }
      }
      const supported = context.capabilities.has("fightBuyPagination") || await context.capabilities.probe("fightBuyPagination", options.signal);
      if (!supported) throw new UnsupportedCapabilityError("fight buy enumeration without Torii or get_fight_buys");
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
      }, attempts, false, [{ code: "TORII_FALLBACK", message: "Fight buys used the bounded aggregate RPC fallback.", source: "starknet-rpc" }]);
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
            where: { fight_idEQ: normalizeU256(fightId, "fightId") },
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
      if (context.torii) {
        try {
          const snapshots = await readToriiFightSnapshots(context, [fightId], normalizeAddress(viewer), options);
          const snapshot = snapshots.data[0];
          if (snapshot) return result(context, startedAt, "torii", snapshot.viewer, snapshots.meta.attempts, snapshots.meta.complete, snapshots.meta.warnings);
        } catch {
          // Direct views below hydrate state only when Torii is unavailable.
        }
      }
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
      const previewStrikeTickets = decodeSingleU256(tickets.data, "strikeTickets");
      return result(context, startedAt, "starknet-rpc", normalizeFightViewerState({
        hasBought,
        ...(choiceIndex === 255 ? {} : { choiceIndex }),
        shares: hasBought ? buyData.amount : 0n,
        boughtAt: hasBought ? buyData.boughtAt : 0n,
        hasRedeemed: decodeSingleBool(redeemed.data, "hasRedeemed"),
        isWinner: previewStrikeTickets > 0n,
        previewStrikeTickets,
        strikeTickets: previewStrikeTickets,
      }), [bought, choice, redeemed, tickets, buy].flatMap((value) => value.attempts));
    },
    async potState(fightId, options = {}) {
      const startedAt = context.now();
      if (context.torii) {
        try {
          const snapshots = await readToriiFightSnapshots(context, [fightId], normalizeAddress("0"), options);
          const snapshot = snapshots.data[0];
          if (snapshot) return result(context, startedAt, "torii", snapshot.pot, snapshots.meta.attempts, snapshots.meta.complete, snapshots.meta.warnings);
        } catch {
          // Direct views below hydrate state only when Torii is unavailable.
        }
      }
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
      if (context.torii) {
        try {
          const response = await context.torii.model<Record<string, unknown>>({
            model: "FightWinner",
            selection: FIGHT_WINNER_SELECTION,
            first: 1,
            where: { fight_idEQ: normalizeU256(fightId, "fightId"), winnerEQ: normalizeAddress(account) },
          }, options);
          const node = response.data.edges[0]?.node;
          return result(context, startedAt, "torii", node ? mapToriiFightWinner(node) : undefined, response.attempts);
        } catch {
          // The exact contract view is the bounded fallback.
        }
      }
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
    if (context.torii) {
      try {
        const response = await context.torii.model<Record<string, unknown>>({
          model: "Market",
          selection: MARKET_SELECTION,
          first: 1,
          where: { market_idEQ: normalizeU256(marketId, "marketId") },
        }, options);
        const node = response.data.edges[0]?.node;
        if (node) return result(context, startedAt, "torii", mapToriiMarket(node), response.attempts);
      } catch {
        // The exact contract view is the bounded fallback when Torii is unavailable.
      }
    }
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
        const supported = context.capabilities.has("fightFeed")
          || await context.capabilities.probe("fightFeed", options.signal);
        if (!supported) throw new UnsupportedCapabilityError("bounded market catalog RPC fallback");
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
        const marketPage = await context.torii.model<Record<string, unknown>>({
          model: "Market",
          selection: MARKET_SELECTION,
          first: clampPageSize(input.limit, context.budget.pageSize, 20),
          ...(toriiCursor ? { after: toriiCursor } : {}),
        }, options);
        if (marketPage.data.edges.length === 0) {
          return result(context, startedAt, "torii", {
            items: [],
            ...(marketPage.data.pageInfo.endCursor ? { cursor: `torii:${marketPage.data.pageInfo.endCursor}` } : {}),
            hasMore: marketPage.data.pageInfo.hasNextPage,
          }, marketPage.attempts);
        }
        const pageMarketIds = marketPage.data.edges.map((edge) => normalizeU256(scalarBigInt(edge.node.market_id, "market_id"), "marketId"));
        const [fights, numerators, denominators] = await Promise.all([
          readAllToriiModels(context, { model: "Fight", selection: FIGHT_SELECTION, where: { market_idIN: pageMarketIds } }, mapToriiFight, options),
          readAllToriiModels(context, { model: "VaultNumerator", selection: VAULT_NUMERATOR_SELECTION, where: { market_idIN: pageMarketIds } }, (node) => ({
            marketId: scalarBigInt(node.market_id, "market_id"),
            index: scalarNumber(node.index, "index"),
            value: scalarBigInt(node.value, "value"),
          }), options),
          readAllToriiModels(context, { model: "VaultDenominator", selection: VAULT_DENOMINATOR_SELECTION, where: { market_idIN: pageMarketIds } }, (node) => ({
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
      if (context.torii) {
        try {
          const marketResult = await get(marketId, options);
          const condition = conditionId ?? marketResult.data.conditionId;
          const [vaults, denominator, payouts, payoutDenominator] = await Promise.all([
            readAllToriiModels(context, { model: "VaultNumerator", selection: VAULT_NUMERATOR_SELECTION, where: { market_idEQ: normalizeU256(marketId, "marketId") } }, (node) => ({ index: scalarNumber(node.index, "index"), value: scalarBigInt(node.value, "value") }), options),
            context.torii.model<Record<string, unknown>>({ model: "VaultDenominator", selection: VAULT_DENOMINATOR_SELECTION, first: 1, where: { market_idEQ: normalizeU256(marketId, "marketId") } }, options),
            readAllToriiModels(context, { model: "PayoutNumerator", selection: PAYOUT_NUMERATOR_SELECTION, where: { condition_idEQ: normalizeU256(condition, "conditionId") } }, (node) => ({ index: scalarNumber(node.index, "index"), value: scalarBigInt(node.value, "value") }), options),
            context.torii.model<Record<string, unknown>>({ model: "PayoutDenominator", selection: PAYOUT_DENOMINATOR_SELECTION, first: 1, where: { condition_idEQ: normalizeU256(condition, "conditionId") } }, options),
          ]);
          const vaultRows = Array.from({ length: outcomeSlotCount }, (_, index) => vaults.items.find((row) => row.index === index)?.value ?? 0n);
          const payoutRows = Array.from({ length: outcomeSlotCount }, (_, index) => payouts.items.find((row) => row.index === index)?.value ?? 0n);
          return result(context, startedAt, "torii", {
            market: marketResult.data,
            vaultNumerators: vaultRows,
            vaultDenominator: denominator.data.edges[0] ? scalarBigInt(denominator.data.edges[0].node.value, "value") : 0n,
            payoutNumerators: payoutRows,
            payoutDenominator: payoutDenominator.data.edges[0] ? scalarBigInt(payoutDenominator.data.edges[0].node.value, "value") : 0n,
          }, [
            ...marketResult.meta.attempts,
            ...vaults.attempts,
            ...denominator.attempts,
            ...payouts.attempts,
            ...payoutDenominator.attempts,
          ], marketResult.meta.complete && vaults.complete && payouts.complete, [...vaults.warnings, ...payouts.warnings]);
        } catch {
          // RPC below is used only when the indexed market state cannot be read.
        }
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
      if (context.torii) {
        try {
          const response = await context.torii.model<Record<string, unknown>>({
            model: "MarketPosition",
            selection: MARKET_POSITION_SELECTION,
            first: 1,
            where: { position_idEQ: normalizeU256(positionId, "positionId") },
          }, options);
          const node = response.data.edges[0]?.node;
          if (node) return result(context, startedAt, "torii", {
            marketId: scalarBigInt(node.market_id, "market_id"),
            positionId: scalarBigInt(node.position_id, "position_id"),
            outcomeIndex: scalarNumber(node.index, "index"),
          }, response.attempts);
        } catch {
          // The exact contract view is the bounded fallback.
        }
      }
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
      if (context.torii) {
        try {
          const balances = await createTokensRepository(context).accountBalances(account, options);
          const match = balances.data.find((value) => value.tokenId === positionId
            && sameAddress(value.contractAddress, context.network.contracts.ConditionalTokens));
          if (balances.meta.complete || match) {
            return result(context, startedAt, "torii", match?.balance ?? 0n, balances.meta.attempts, balances.meta.complete, balances.meta.warnings);
          }
        } catch {
          // Direct balance_of is the bounded fallback.
        }
      }
      const response = await rpcCall(context, "ConditionalTokens", "balance_of", [normalizeAddress(account), ...encodeU256(positionId)], options);
      return result(context, startedAt, "starknet-rpc", decodeSingleU256(response.data, "conditionalBalance"), response.attempts);
    },
  };
}

export interface TokensRepository {
  accountBalances(account: Address, options?: RequestOptions): Promise<DataResult<IndexedTokenBalance[]>>;
  strikeTicketBalances(account: Address, options?: RequestOptions): Promise<DataResult<IndexedTokenBalance[]>>;
  callsBalance(account: Address, options?: RequestOptions): Promise<DataResult<bigint>>;
  callsAllowance(owner: Address, spender?: Address, options?: RequestOptions): Promise<DataResult<bigint>>;
  strikeTicketBalance(account: Address, fightId: bigint, options?: RequestOptions): Promise<DataResult<bigint>>;
  vaultPositionBalance(account: Address, positionId: bigint, options?: RequestOptions): Promise<DataResult<bigint>>;
  isApprovedForAll(token: "StrikeTickets" | "VaultPositions" | "ConditionalTokens", owner: Address, operator: Address, options?: RequestOptions): Promise<DataResult<boolean>>;
}

export function createTokensRepository(context: RepositoryContext): TokensRepository {
  const accountBalances = async (account: Address, options: RequestOptions = {}) => {
    const startedAt = context.now();
    if (!context.torii) throw new UnsupportedCapabilityError("indexed token balances without Torii");
    const budget = resolveRequestBudget(context.budget, options);
    const balances: IndexedTokenBalance[] = [];
    const attempts: SourceAttempt[] = [];
    const warnings: DataWarning[] = [];
    let offset = 0;
    let complete = false;
    for (let page = 0; page < budget.maxToriiPages && balances.length < budget.maxToriiItems; page += 1) {
      const response = await context.torii.tokenBalances(account, {
        offset,
        limit: Math.min(context.budget.pageSize, budget.maxToriiItems - balances.length),
      }, options);
      attempts.push(...response.attempts);
      for (const edge of response.data.edges) {
        const token = edge.node.tokenMetadata;
        const rawBalance = edge.node.balance ?? token?.amount ?? (token?.__typename === "ERC721__Token" ? "1" : undefined);
        if (!token?.contractAddress || rawBalance === undefined) continue;
        let balance: bigint;
        let tokenId: bigint | undefined;
        try {
          balance = BigInt(rawBalance);
          if (token.tokenId !== undefined) tokenId = BigInt(token.tokenId);
        } catch {
          warnings.push({ code: "TORII_TOKEN_BALANCE_INVALID", message: "Torii returned a malformed token balance.", source: "torii" });
          continue;
        }
        const tokenType = token.__typename === "ERC20__Token"
          ? "erc20" as const
          : token.__typename === "ERC721__Token"
            ? "erc721" as const
            : token.__typename === "ERC1155__Token"
              ? "erc1155" as const
              : undefined;
        balances.push({
          contractAddress: normalizeAddress(token.contractAddress),
          ...(tokenId === undefined ? {} : { tokenId }),
          balance,
          ...(tokenType ? { tokenType } : {}),
        });
      }
      offset += response.data.edges.length;
      if (response.data.edges.length === 0 || offset >= response.data.totalCount) {
        complete = true;
        break;
      }
    }
    if (!complete) warnings.push({
      code: balances.length >= budget.maxToriiItems ? "TORII_ITEM_LIMIT" : "TORII_PAGE_LIMIT",
      message: "Token balance enumeration reached the configured Torii traversal budget.",
      source: "torii",
    });
    return result(context, startedAt, "torii", balances, attempts, complete, warnings);
  };

  const indexedBalance = async (
    contract: "CALLS" | "StrikeTickets" | "VaultPositions",
    account: Address,
    tokenId: bigint | undefined,
    operation: string,
    options: RequestOptions,
  ): Promise<DataResult<bigint>> => {
    const startedAt = context.now();
    if (context.torii) {
      try {
        const balances = await accountBalances(account, options);
        const match = balances.data.find((value) => sameAddress(value.contractAddress, context.network.contracts[contract])
          && (tokenId === undefined ? value.tokenId === undefined : value.tokenId === tokenId));
        if (balances.meta.complete || match) {
          return result(context, startedAt, "torii", match?.balance ?? 0n, balances.meta.attempts, balances.meta.complete, balances.meta.warnings);
        }
      } catch {
        // RPC is the bounded fallback for an unavailable Torii balance index.
      }
    }
    return balance(contract, account, tokenId, operation, options);
  };

  const balance = async (contract: "CALLS" | "StrikeTickets" | "VaultPositions", account: Address, tokenId: bigint | undefined, operation: string, options: RequestOptions) => {
    const startedAt = context.now();
    const calldata = tokenId === undefined ? [normalizeAddress(account)] : [normalizeAddress(account), ...encodeU256(tokenId)];
    const response = await rpcCall(context, contract, "balance_of", calldata, options);
    return result(context, startedAt, "starknet-rpc", decodeSingleU256(response.data, operation), response.attempts);
  };
  return {
    accountBalances,
    async strikeTicketBalances(account, options = {}) {
      const startedAt = context.now();
      const balances = await accountBalances(account, options);
      return result(context, startedAt, "torii", balances.data.filter((value) =>
        value.tokenId !== undefined && sameAddress(value.contractAddress, context.network.contracts.StrikeTickets)),
      balances.meta.attempts, balances.meta.complete, balances.meta.warnings);
    },
    callsBalance(account, options = {}) { return indexedBalance("CALLS", account, undefined, "callsBalance", options); },
    async callsAllowance(owner, spender = context.network.contracts.Markets, options = {}) {
      const startedAt = context.now();
      const response = await rpcCall(context, "CALLS", "allowance", [normalizeAddress(owner), normalizeAddress(spender)], options);
      return result(context, startedAt, "starknet-rpc", decodeSingleU256(response.data, "callsAllowance"), response.attempts);
    },
    strikeTicketBalance(account, fightId, options = {}) { return indexedBalance("StrikeTickets", account, fightId, "strikeTicketBalance", options); },
    vaultPositionBalance(account, positionId, options = {}) { return indexedBalance("VaultPositions", account, positionId, "vaultPositionBalance", options); },
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
      const [open, size] = await Promise.all([
        rpcCall(context, "Gacha", "pool_open", id, options),
        rpcCall(context, "Gacha", "pool_size", id, options),
      ]);
      return result(context, startedAt, "starknet-rpc", {
        fightId,
        open: decodeSingleBool(open.data, "poolOpen"),
        size: decodeSingleU256(size.data, "poolSize"),
        rarities: [],
      }, [...open.attempts, ...size.attempts], false, [{
        code: "CAPABILITY_FALLBACK",
        message: "This deployment lacks the aggregate Gacha pool view; open and size were retained without per-rarity RPC fan-out.",
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
      if (unique.length !== 1) throw new UnsupportedCapabilityError("Gacha pool batches without get_pool_states");
      const fallback = await createGachaRepository(context, tokens).pool(unique[0]!, options);
      return result(context, startedAt, "starknet-rpc", [fallback.data], fallback.meta.attempts, false, fallback.meta.warnings);
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
      if (ids.length !== 1) throw new UnsupportedCapabilityError("Gacha account-state batches without get_user_states");
      const states = await mapConcurrent(ids, 1, async (fightId) => {
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
