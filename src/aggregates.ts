import { createDataResult, mapConcurrent } from "./core.js";
import { normalizeAddress } from "./codecs.js";
import type { FightsRepository, GachaRepository, RepositoryContext, TokensRepository } from "./repositories.js";
import type { RelicsRepository } from "./relics.js";
import { transportAttemptsFromError } from "./transports.js";
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
} from "./types.js";

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

export interface EventsRepository {
  get(ref: EventRef, options?: RequestOptions): Promise<DataResult<PublicEventSnapshot>>;
}

export interface AccountsRepository {
  event(ref: EventRef, account: Address, options?: RequestOptions): Promise<DataResult<AccountEventState>>;
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
  let complete = true;
  const enriched = await mapConcurrent(fights, context.budget.maxConcurrency, async (fight) => {
    try {
      const pool = await gacha.pool(fight.fightId, options);
      attempts.push(...pool.meta.attempts);
      warnings.push(...pool.meta.warnings);
      complete &&= pool.meta.complete;
      return { fight, gachaPool: pool.data };
    } catch (error) {
      attempts.push(...transportAttemptsFromError(error));
      warnings.push(warning(`Gacha pool for fight ${fight.fightId}`, error));
      complete = false;
      return { fight };
    }
  });
  return { fights: enriched, complete };
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
    const publicFights = await enrichPools(context, dependencies.gacha, fights, attempts, warnings, options);
    let accountComplete = feed.meta.complete && publicFights.complete;
    const accountFights = await mapConcurrent(publicFights.fights, context.budget.maxConcurrency, async (fight): Promise<AccountEventFightState> => {
      try {
        const user = await dependencies.gacha.user(fight.fight.fightId, account, options);
        attempts.push(...user.meta.attempts);
        warnings.push(...user.meta.warnings);
        accountComplete &&= user.meta.complete;
        return { ...fight, gachaUser: user.data };
      } catch (error) {
        attempts.push(...transportAttemptsFromError(error));
        warnings.push(warning(`Gacha account state for fight ${fight.fight.fightId}`, error));
        accountComplete = false;
        return fight;
      }
    });
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
      async portfolio(accountInput, options = {}) {
        const account = normalizeAddress(accountInput);
        const startedAt = context.now();
        const attempts: SourceAttempt[] = [];
        const warnings: DataWarning[] = [];
        const reads = await Promise.allSettled([
          dependencies.fights.feedAll({ viewer: account }, options),
          dependencies.fights.portfolioAll(account, options),
          dependencies.relics.owned(account, options),
          dependencies.tokens.callsBalance(account, options),
        ]);
        const [feedRead, buysRead, relicsRead, balanceRead] = reads;
        if (feedRead.status === "rejected") throw feedRead.reason;
        const feed = feedRead.value;
        attempts.push(...feed.meta.attempts);
        warnings.push(...feed.meta.warnings);
        let complete = feed.meta.complete;
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
        const buys = absorb(buysRead, "Fight buys", [] as FightBuy[]);
        const relicPage = absorb(relicsRead, "Owned relics", undefined);
        const callsBalance = absorb(balanceRead, "CALLS balance", 0n);
        const relevant = feed.data.filter((fight) => fight.viewer.hasBought || fight.viewer.strikeTickets > 0n);
        const publicFights = await enrichPools(context, dependencies.gacha, relevant, attempts, warnings, options);
        complete &&= publicFights.complete;
        const fights = await mapConcurrent(publicFights.fights, context.budget.maxConcurrency, async (fight): Promise<AccountEventFightState> => {
          try {
            const user = await dependencies.gacha.user(fight.fight.fightId, account, options);
            attempts.push(...user.meta.attempts);
            warnings.push(...user.meta.warnings);
            complete &&= user.meta.complete;
            return { ...fight, gachaUser: user.data };
          } catch (error) {
            attempts.push(...transportAttemptsFromError(error));
            warnings.push(warning(`Gacha account state for fight ${fight.fight.fightId}`, error));
            complete = false;
            return fight;
          }
        });
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
