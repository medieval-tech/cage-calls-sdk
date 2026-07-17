import { createDataResult, mapConcurrent } from "../core/request.js";
import { normalizeAddress } from "../core/codecs.js";
import type { FightsRepository, GachaRepository, RepositoryContext, TokensRepository } from "./index.js";
import type { RelicsRepository } from "./relics.js";
import { transportAttemptsFromError } from "../transports/index.js";
import type {
  Address,
  DataResult,
  DataWarning,
  FightBuy,
  FightFeedItem,
  GachaPoolState,
  GachaUserState,
  Relic,
  RequestOptions,
  SourceAttempt,
} from "../core/types.js";

export interface EventRef {
  seasonId: bigint;
  eventName: string;
}

export interface PublicEventFight {
  fight: FightFeedItem;
  gachaPool?: GachaPoolState;
}

export interface PublicEventSnapshot {
  ref: EventRef;
  lifecycle: "upcoming" | "open" | "closed" | "settled" | "mixed";
  fights: PublicEventFight[];
}

export type AccountAction =
  | { type: "redeem-payout"; fightId: bigint }
  | { type: "strike-gacha"; fightId: bigint; ticketBalance: bigint }
  | { type: "keep-relic"; fightId: bigint; tokenId: bigint };

export interface AccountEventFightState extends PublicEventFight {
  gachaUser?: GachaUserState;
}

export interface AccountEventState {
  account: Address;
  ref: EventRef;
  lifecycle: PublicEventSnapshot["lifecycle"];
  fights: AccountEventFightState[];
  relics: Relic[];
  actions: AccountAction[];
}

export interface AccountPortfolio {
  account: Address;
  callsBalance: bigint;
  buys: FightBuy[];
  fights: AccountEventFightState[];
  relics: Relic[];
  actions: AccountAction[];
}

export interface AccountFightStatePage {
  account: Address;
  items: AccountEventFightState[];
  actions: AccountAction[];
  cursor?: bigint;
  hasMore: boolean;
}

export interface EventsRepository {
  get(ref: EventRef, options?: RequestOptions): Promise<DataResult<PublicEventSnapshot>>;
}

export interface AccountsRepository {
  event(ref: EventRef, account: Address, options?: RequestOptions): Promise<DataResult<AccountEventState>>;
  fightStates(account: Address, input?: { limit?: number; cursor?: bigint }, options?: RequestOptions): Promise<DataResult<AccountFightStatePage>>;
  portfolio(account: Address, options?: RequestOptions): Promise<DataResult<AccountPortfolio>>;
}

function matchesEvent(fight: FightFeedItem, ref: EventRef): boolean {
  return fight.seasonId === ref.seasonId && fight.eventName === ref.eventName;
}

function lifecycle(fights: readonly FightFeedItem[], now: bigint): PublicEventSnapshot["lifecycle"] {
  if (fights.length === 0) return "mixed";
  const states = new Set(fights.map((fight) => {
    if (fight.pot.settled) return "settled" as const;
    if (fight.pot.closed || now >= fight.endAt) return "closed" as const;
    if (now >= fight.startAt) return "open" as const;
    return "upcoming" as const;
  }));
  return states.size === 1 ? (states.values().next().value ?? "mixed") : "mixed";
}

function warning(operation: string, error: unknown): DataWarning {
  return {
    code: "PARTIAL_AGGREGATE",
    message: `${operation} could not be loaded; the rest of the aggregate was retained.`,
  };
}

function actionsFor(fight: AccountEventFightState): AccountAction[] {
  const actions: AccountAction[] = [];
  if (fight.fight.viewer.isWinner && !fight.fight.viewer.hasRedeemed) {
    actions.push({ type: "redeem-payout", fightId: fight.fight.fightId });
  }
  if (fight.gachaUser?.escrowedTokenId !== undefined) {
    actions.push({ type: "keep-relic", fightId: fight.fight.fightId, tokenId: fight.gachaUser.escrowedTokenId });
  } else if (fight.gachaPool?.open && (fight.gachaUser?.ticketBalance ?? 0n) > 0n) {
    actions.push({ type: "strike-gacha", fightId: fight.fight.fightId, ticketBalance: fight.gachaUser?.ticketBalance ?? 0n });
  }
  return actions;
}

function aggregateResult<T>(
  context: RepositoryContext,
  startedAt: number,
  data: T,
  attempts: SourceAttempt[],
  warnings: DataWarning[],
  complete: boolean,
): DataResult<T> {
  return createDataResult({
    data,
    source: "derived",
    complete,
    attempts,
    warnings,
    startedAt,
    now: context.now,
    ...(context.logger ? { logger: context.logger } : {}),
  });
}

async function enrichPools(
  context: RepositoryContext,
  gacha: GachaRepository,
  fights: readonly FightFeedItem[],
  attempts: SourceAttempt[],
  warnings: DataWarning[],
  options: RequestOptions,
): Promise<{ fights: PublicEventFight[]; complete: boolean }> {
  try {
    const pools = await gacha.poolStates(fights.map((fight) => fight.fightId), options);
    attempts.push(...pools.meta.attempts);
    warnings.push(...pools.meta.warnings);
    const byFight = new Map(pools.data.map((pool) => [pool.fightId.toString(), pool]));
    return {
      fights: fights.map((fight) => {
        const pool = byFight.get(fight.fightId.toString());
        return pool ? { fight, gachaPool: pool } : { fight };
      }),
      complete: pools.meta.complete && pools.data.length === fights.length,
    };
  } catch (error) {
    attempts.push(...transportAttemptsFromError(error));
    warnings.push(warning("Gacha pool batch", error));
    return { fights: fights.map((fight) => ({ fight })), complete: false };
  }
}

async function enrichAccountFights(
  context: RepositoryContext,
  gacha: GachaRepository,
  fights: readonly FightFeedItem[],
  account: Address,
  attempts: SourceAttempt[],
  warnings: DataWarning[],
  options: RequestOptions,
): Promise<{ fights: AccountEventFightState[]; complete: boolean }> {
  let complete = true;
  const output: AccountEventFightState[] = [];
  if (typeof gacha.userStates !== "function") {
    const legacy = await mapConcurrent(fights, context.budget.maxConcurrency, async (fight): Promise<AccountEventFightState> => {
      try {
        const [pool, user] = await Promise.all([gacha.pool(fight.fightId, options), gacha.user(fight.fightId, account, options)]);
        attempts.push(...pool.meta.attempts, ...user.meta.attempts);
        complete &&= pool.meta.complete && user.meta.complete;
        return { fight, gachaPool: pool.data, gachaUser: user.data };
      } catch (error) {
        attempts.push(...transportAttemptsFromError(error));
        warnings.push(warning(`Gacha account state for fight ${fight.fightId}`, error));
        complete = false;
        return { fight };
      }
    });
    return { fights: legacy, complete };
  }
  for (let offset = 0; offset < fights.length; offset += 20) {
    const batch = fights.slice(offset, offset + 20);
    try {
      const states = await gacha.userStates(batch.map((fight) => fight.fightId), account, options);
      attempts.push(...states.meta.attempts);
      warnings.push(...states.meta.warnings);
      complete &&= states.meta.complete;
      const byFight = new Map(states.data.states.map((state) => [state.fightId.toString(), state]));
      for (const fight of batch) {
        const state = byFight.get(fight.fightId.toString());
        output.push(state ? { fight, gachaPool: state.pool, gachaUser: state } : { fight });
        if (!state) complete = false;
      }
    } catch (error) {
      attempts.push(...transportAttemptsFromError(error));
      warnings.push(warning("Gacha account-state batch", error));
      complete = false;
      output.push(...batch.map((fight) => ({ fight })));
    }
  }
  return { fights: output, complete };
}

export function createAggregateRepositories(
  context: RepositoryContext,
  dependencies: {
    fights: FightsRepository;
    gacha: GachaRepository;
    relics: RelicsRepository;
    tokens: TokensRepository;
  },
): { events: EventsRepository; accounts: AccountsRepository } {
  const publicEvent = async (ref: EventRef, options: RequestOptions = {}): Promise<DataResult<PublicEventSnapshot>> => {
    const startedAt = context.now();
    const attempts: SourceAttempt[] = [];
    const warnings: DataWarning[] = [];
    const feed = await dependencies.fights.feedAll({}, options);
    attempts.push(...feed.meta.attempts);
    warnings.push(...feed.meta.warnings);
    const fights = feed.data.filter((fight) => matchesEvent(fight, ref));
    const enriched = await enrichPools(context, dependencies.gacha, fights, attempts, warnings, options);
    return aggregateResult(context, startedAt, {
      ref,
      lifecycle: lifecycle(fights, BigInt(Math.floor(context.now() / 1_000))),
      fights: enriched.fights,
    }, attempts, warnings, feed.meta.complete && enriched.complete);
  };

  const eventForAccount = async (ref: EventRef, accountInput: Address, options: RequestOptions = {}): Promise<DataResult<AccountEventState>> => {
    const account = normalizeAddress(accountInput);
    const startedAt = context.now();
    const attempts: SourceAttempt[] = [];
    const warnings: DataWarning[] = [];
    const [feedResult, relicResult] = await Promise.allSettled([
      dependencies.fights.feedAll({ viewer: account }, options),
      dependencies.relics.owned(account, options),
    ]);
    if (feedResult.status === "rejected") throw feedResult.reason;
    const feed = feedResult.value;
    attempts.push(...feed.meta.attempts);
    warnings.push(...feed.meta.warnings);
    const fights = feed.data.filter((fight) => matchesEvent(fight, ref));
    const accountState = await enrichAccountFights(context, dependencies.gacha, fights, account, attempts, warnings, options);
    let accountComplete = feed.meta.complete && accountState.complete;
    const accountFights = accountState.fights;
    let relics: Relic[] = [];
    let relicsComplete = false;
    if (relicResult.status === "fulfilled") {
      attempts.push(...relicResult.value.meta.attempts);
      warnings.push(...relicResult.value.meta.warnings);
      const fightIds = new Set(fights.map((fight) => fight.fightId.toString()));
      relics = relicResult.value.data.items.filter((relic) => relic.metadata && fightIds.has(relic.metadata.fightId.toString()));
      relicsComplete = relicResult.value.meta.complete;
    } else {
      attempts.push(...transportAttemptsFromError(relicResult.reason));
      warnings.push(warning("Owned relics", relicResult.reason));
    }
    return aggregateResult(context, startedAt, {
      account,
      ref,
      lifecycle: lifecycle(fights, BigInt(Math.floor(context.now() / 1_000))),
      fights: accountFights,
      relics,
      actions: accountFights.flatMap(actionsFor),
    }, attempts, warnings, accountComplete && relicsComplete);
  };

  return {
    events: { get: publicEvent },
    accounts: {
      event: eventForAccount,
      async fightStates(accountInput, input = {}, options = {}) {
        const account = normalizeAddress(accountInput);
        const startedAt = context.now();
        const attempts: SourceAttempt[] = [];
        const warnings: DataWarning[] = [];
        const limit = Math.max(1, Math.min(input.limit ?? 20, 100));
        try {
          const portfolio = await dependencies.fights.portfolioAll(account, options);
          attempts.push(...portfolio.meta.attempts);
          warnings.push(...portfolio.meta.warnings);
          const ordered = portfolio.data
            .slice()
            .sort((left, right) => left.fightId === right.fightId ? 0 : left.fightId > right.fightId ? -1 : 1)
            .filter((buy) => input.cursor === undefined || input.cursor === 0n || buy.fightId <= input.cursor);
          const pageBuys = ordered.slice(0, limit);
          const snapshots = await dependencies.fights.feedMany(pageBuys.map((buy) => buy.fightId), { viewer: account }, options);
          attempts.push(...snapshots.meta.attempts);
          warnings.push(...snapshots.meta.warnings);
          const items = snapshots.data.map((fight) => ({ fight }));
          const hasMore = ordered.length > pageBuys.length;
          const oldest = pageBuys.at(-1)?.fightId ?? 0n;
          return aggregateResult(context, startedAt, {
            account,
            items,
            actions: items.flatMap(actionsFor),
            ...(hasMore && oldest > 1n ? { cursor: oldest - 1n } : {}),
            hasMore,
          }, attempts, warnings, portfolio.meta.complete && snapshots.meta.complete);
        } catch (error) {
          attempts.push(...transportAttemptsFromError(error));
          const fallback = await dependencies.fights.accountFeed(account, { limit, ...(input.cursor === undefined ? {} : { cursor: input.cursor }) }, options);
          attempts.push(...fallback.meta.attempts);
          warnings.push(...fallback.meta.warnings, {
            code: "TORII_FALLBACK",
            message: "Account positions used the bounded aggregate contract view because Torii was unavailable.",
            source: "starknet-rpc",
          });
          const items = fallback.data.items.map((fight) => ({ fight }));
          return aggregateResult(context, startedAt, {
            account,
            items,
            actions: items.flatMap(actionsFor),
            ...(fallback.data.cursor === undefined ? {} : { cursor: fallback.data.cursor }),
            hasMore: fallback.data.hasMore,
          }, attempts, warnings, fallback.meta.complete);
        }
      },
      async portfolio(accountInput, options = {}) {
        const account = normalizeAddress(accountInput);
        const startedAt = context.now();
        const attempts: SourceAttempt[] = [];
        const warnings: DataWarning[] = [];
        const reads = await Promise.allSettled([
          dependencies.fights.portfolioAll(account, options),
          dependencies.relics.owned(account, options),
          dependencies.tokens.callsBalance(account, options),
        ]);
        const [buysRead, relicsRead, balanceRead] = reads;
        let buys: FightBuy[];
        let prefetchedFights: FightFeedItem[] | undefined;
        let complete: boolean;
        if (buysRead.status === "fulfilled") {
          attempts.push(...buysRead.value.meta.attempts);
          warnings.push(...buysRead.value.meta.warnings);
          buys = buysRead.value.data;
          complete = buysRead.value.meta.complete;
        } else {
          attempts.push(...transportAttemptsFromError(buysRead.reason));
          const fallback = await dependencies.fights.accountFeedAll(account, options);
          attempts.push(...fallback.meta.attempts);
          warnings.push(...fallback.meta.warnings, {
            code: "TORII_FALLBACK",
            message: "Account portfolio used the bounded aggregate contract view because Torii was unavailable.",
            source: "starknet-rpc",
          });
          prefetchedFights = fallback.data;
          buys = fallback.data.flatMap((fight): FightBuy[] => fight.viewer.hasBought && fight.viewer.choiceIndex !== undefined ? [{
            fightId: fight.fightId,
            buyer: account,
            marketId: fight.marketId,
            choiceIndex: fight.viewer.choiceIndex,
            amount: fight.viewer.shares,
            boughtAt: fight.viewer.boughtAt,
          }] : []);
          complete = fallback.meta.complete;
        }
        const absorb = <T>(read: PromiseSettledResult<DataResult<T>>, label: string, fallback: T): T => {
          if (read.status === "fulfilled") {
            attempts.push(...read.value.meta.attempts);
            warnings.push(...read.value.meta.warnings);
            complete &&= read.value.meta.complete;
            return read.value.data;
          }
          attempts.push(...transportAttemptsFromError(read.reason));
          warnings.push(warning(label, read.reason));
          complete = false;
          return fallback;
        };
        const relicPage = absorb(relicsRead, "Owned relics", undefined);
        const callsBalance = absorb(balanceRead, "CALLS balance", 0n);
        const snapshots = prefetchedFights === undefined
          ? await dependencies.fights.feedMany(buys.map((buy) => buy.fightId), { viewer: account }, options)
          : undefined;
        if (snapshots) {
          attempts.push(...snapshots.meta.attempts);
          warnings.push(...snapshots.meta.warnings);
          complete &&= snapshots.meta.complete;
        }
        const fights = (snapshots?.data ?? prefetchedFights ?? []).map((fight) => ({ fight }));
        const relics = relicPage?.items ?? [];
        return aggregateResult(context, startedAt, {
          account,
          callsBalance,
          buys,
          fights,
          relics,
          actions: fights.flatMap(actionsFor),
        }, attempts, warnings, complete);
      },
    },
  };
}
