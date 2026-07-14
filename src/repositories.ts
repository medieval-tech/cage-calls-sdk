import { createDataResult, mapConcurrent } from "./core.js";
import { clampPageSize, encodeU256, normalizeAddress } from "./codecs.js";
import {
  decodeFightBuyRpc,
  decodeFightBuysRpc,
  decodeFightFeedRpc,
  decodeFightRpc,
  decodeFightersRpc,
  decodeFighterRpc,
  decodeFightWinnerRpc,
  decodeGachaPoolStateRpc,
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
} from "./decoders.js";
import { AllSourcesFailedError, UnsupportedCapabilityError, ValidationError } from "./errors.js";
import type { CapabilityRegistry } from "./network.js";
import type { RpcTransport, ToriiTransport, TransportResult } from "./transports.js";
import { transportAttemptsFromError } from "./transports.js";
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
  GachaPoolState,
  GachaUserState,
  Market,
  MarketPosition,
  MarketState,
  Page,
  RequestBudget,
  RequestOptions,
  SdkLogger,
  SourceAttempt,
} from "./types.js";

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

export interface FightersRepository {
  get(fighterId: bigint, options?: RequestOptions): Promise<DataResult<Fighter>>;
  getMany(fighterIds: readonly bigint[], options?: RequestOptions): Promise<DataResult<Fighter[]>>;
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
          where: { fighter_idEQ: fighterId.toString() },
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

  return {
    get,
    async getMany(fighterIds, options = {}) {
      const startedAt = context.now();
      const unique = Array.from(new Set(fighterIds));
      if (unique.length === 0) return result(context, startedAt, "derived", [], []);
      const supportsBatch = context.capabilities.has("fighterBatch") || await context.capabilities.probe("fighterBatch", options.signal);
      if (supportsBatch) {
        const bounded = unique.slice(0, 20);
        const calldata = [bounded.length.toString(), ...bounded.flatMap(encodeU256)];
        const response = await rpcCall(context, "FighterRegistry", "get_fighters", calldata, options);
        return result(context, startedAt, "starknet-rpc", decodeFightersRpc(response.data), response.attempts, bounded.length === unique.length,
          bounded.length === unique.length ? [] : [{ code: "BUDGET_LIMIT", message: "Fighter batch was capped at 20 items." }]);
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
    async list(input = {}, options = {}) {
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
        throw new AllSourcesFailedError("fighters.list", transportAttemptsFromError(error));
      }
    },
    async isAdmin(account, options = {}) {
      const startedAt = context.now();
      const response = await rpcCall(context, "FighterRegistry", "is_admin", [normalizeAddress(account)], options);
      return result(context, startedAt, "starknet-rpc", decodeSingleBool(response.data, "fighterRegistry.isAdmin"), response.attempts);
    },
  };
}

export interface FightsRepository {
  get(fightId: bigint, options?: RequestOptions): Promise<DataResult<Fight>>;
  list(input?: { limit?: number; cursor?: string; seasonId?: bigint }, options?: RequestOptions): Promise<DataResult<Page<Fight>>>;
  feed(input?: { limit?: number; cursor?: bigint; viewer?: Address }, options?: RequestOptions): Promise<DataResult<Page<FightFeedItem, bigint>>>;
  buys(fightId: bigint, input?: { offset?: number; limit?: number }, options?: RequestOptions): Promise<DataResult<Page<FightBuy, number>>>;
  viewerState(fightId: bigint, viewer: Address, options?: RequestOptions): Promise<DataResult<FightViewerState>>;
  potState(fightId: bigint, options?: RequestOptions): Promise<DataResult<FightPotState>>;
  winner(fightId: bigint, account: Address, options?: RequestOptions): Promise<DataResult<FightWinner | undefined>>;
  portfolio(account: Address, input?: { limit?: number; cursor?: string }, options?: RequestOptions): Promise<DataResult<Page<FightBuy>>>;
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
          ...(input.seasonId === undefined ? {} : { where: { season_idEQ: input.seasonId.toString() } }),
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
    list,
    async feed(input = {}, options = {}) {
      const startedAt = context.now();
      const supported = context.capabilities.has("fightFeed") || await context.capabilities.probe("fightFeed", options.signal);
      if (!supported) throw new UnsupportedCapabilityError("fight aggregate feed", { network: context.network.name });
      const size = clampPageSize(input.limit, 20, 20);
      const start = input.cursor ?? 0n;
      const response = await rpcCall(context, "FightFactory", "get_fight_feed", [
        ...encodeU256(start),
        size.toString(),
        normalizeAddress(input.viewer ?? "0x0"),
      ], options);
      const items = decodeFightFeedRpc(response.data);
      const oldest = items.at(-1)?.fightId ?? 0n;
      const cursor = oldest > 1n ? oldest - 1n : 0n;
      return result(context, startedAt, "starknet-rpc", { items, cursor, hasMore: items.length === size && cursor > 0n }, response.attempts);
    },
    async buys(fightId, input = {}, options = {}) {
      const startedAt = context.now();
      const offset = input.offset ?? 0;
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
      const response = await context.torii.model<Record<string, unknown>>({
        model: "FightBuy",
        selection: FIGHT_BUY_SELECTION,
        first: size,
        where: { fight_idEQ: fightId.toString() },
      }, options);
      const items = response.data.edges.slice(offset).map((edge) => mapToriiFightBuy(edge.node));
      return result(context, startedAt, "torii", { items, hasMore: response.data.pageInfo.hasNextPage }, response.attempts);
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
  };
}

export interface MarketsRepository {
  get(marketId: bigint, options?: RequestOptions): Promise<DataResult<Market>>;
  list(input?: { limit?: number; cursor?: string }, options?: RequestOptions): Promise<DataResult<Page<Market>>>;
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

  return {
    get,
    async list(input = {}, options = {}) {
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
  user(fightId: bigint, account: Address, options?: RequestOptions): Promise<DataResult<GachaUserState>>;
  availableTokenIds(fightId: bigint, input?: { cursor?: bigint; limit?: number }, options?: RequestOptions): Promise<DataResult<Page<bigint, bigint>>>;
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
  list(input?: { limit?: number; cursor?: bigint; viewer?: Address; now?: bigint }, options?: RequestOptions): Promise<DataResult<Page<FightEvent, bigint>>>;
}

export function createFightEventsRepository(context: RepositoryContext, fights: FightsRepository): FightEventsRepository {
  return {
    async list(input = {}, options = {}) {
      const startedAt = context.now();
      const page = await fights.feed(input, options);
      const groups = new Map<string, FightFeedItem[]>();
      for (const fight of page.data.items) {
        const key = `${fight.seasonId}:${fight.eventName}`;
        groups.set(key, [...(groups.get(key) ?? []), fight]);
      }
      const now = input.now ?? BigInt(Math.floor(context.now() / 1_000));
      const events = Array.from(groups.values()).map((items): FightEvent => {
        const states = new Set(items.map((fight) => {
          if (fight.pot.settled) return "settled" as const;
          if (fight.pot.closed || now >= fight.endAt) return "closed" as const;
          if (now >= fight.startAt) return "open" as const;
          return "upcoming" as const;
        }));
        const first = items[0];
        if (!first) throw new ValidationError("Fight event group is empty.");
        return {
          seasonId: first.seasonId,
          eventName: first.eventName,
          fights: items,
          lifecycle: states.size === 1 ? (states.values().next().value ?? "mixed") : "mixed",
        };
      });
      return result(context, startedAt, "derived", {
        items: events,
        ...(page.data.cursor === undefined ? {} : { cursor: page.data.cursor }),
        hasMore: page.data.hasMore,
      }, page.meta.attempts, page.meta.complete, page.meta.warnings);
    },
  };
}
