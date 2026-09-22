import { createDataResult } from "../core/request.js";
import { summarizeAnalyticsSnapshot, type AnalyticsSummaryFilter, type CageCallsAnalyticsSummary } from "./analytics-summary.js";
import { normalizeAddress } from "../core/codecs.js";
import { mapToriiFight, scalarBigInt, scalarNumber } from "../core/decoders.js";
import { createFightsRepository, type RepositoryContext } from "./index.js";
import { readAllToriiModels } from "../transports/torii-models.js";
import { readToriiWinnerChoices } from "./torii-fights.js";
import { transportAttemptsFromError } from "../transports/index.js";
import type {
  AnalyticsBuy,
  AnalyticsSnapshot,
  DataResult,
  DataSource,
  DataWarning,
  Fight,
  RequestOptions,
  SourceAttempt,
} from "../core/types.js";

const FIGHT_SELECTION = [
  "fight_id", "season_id", "event", "market_id", "fighter_a_id", "fighter_a_name",
  "fighter_a_weight_class", "choice_a_value", "choice_a_label", "fighter_b_id",
  "fighter_b_name", "fighter_b_weight_class", "choice_b_value", "choice_b_label",
  "created_at", "is_dev", "sponsor",
] as const;

/**
 * One SQL read for the whole FightBuy model. GraphQL pagination of the same
 * rows takes dozens of pages, each a count + sort over the table.
 */
const FIGHT_BUYS_SQL = 'SELECT fight_id, buyer, choice_index, bought_at FROM "pm-FightBuy"';

export interface AnalyticsRepository {
  snapshot(options?: RequestOptions): Promise<DataResult<AnalyticsSnapshot>>;
  summary(filter?: AnalyticsSummaryFilter, options?: RequestOptions): Promise<DataResult<CageCallsAnalyticsSummary>>;
}

interface PartialRead {
  attempts: SourceAttempt[];
  complete: boolean;
  warnings: DataWarning[];
}

interface FightsRead extends PartialRead {
  fights: Fight[];
  winnerChoiceByFight: Record<string, number>;
  source: DataSource;
}

interface BuysRead extends PartialRead {
  buys: AnalyticsBuy[];
}

function failed(error: unknown, code: string, message: string, source: DataSource): PartialRead {
  return { attempts: transportAttemptsFromError(error), complete: false, warnings: [{ code, message, source }] };
}

export function mapSqlFightBuy(row: Record<string, unknown>): AnalyticsBuy {
  return {
    fightId: scalarBigInt(row.fight_id, "fight_id"),
    buyer: normalizeAddress(String(row.buyer)),
    choiceIndex: scalarNumber(row.choice_index, "choice_index"),
    boughtAt: scalarBigInt(row.bought_at, "bought_at"),
  };
}

async function readFights(context: RepositoryContext, options: RequestOptions): Promise<FightsRead> {
  if (!context.torii) {
    const feed = await createFightsRepository(context).feedAll({}, options);
    const winnerChoiceByFight = Object.fromEntries(feed.data.flatMap((fight) =>
      fight.pot.settled && fight.pot.winnerIndex !== undefined
        ? [[fight.fightId.toString(), fight.pot.winnerIndex] as const]
        : []));
    const { attempts, complete, warnings } = feed.meta;
    return { fights: feed.data, winnerChoiceByFight, source: "starknet-rpc", attempts, complete, warnings };
  }
  const [fights, winners] = await Promise.all([
    readAllToriiModels(context, { model: "Fight", selection: FIGHT_SELECTION }, mapToriiFight, options)
      .catch((error) => ({ items: [] as Fight[], ...failed(error, "TORII_UNAVAILABLE", "Fight enumeration failed.", "torii") })),
    readToriiWinnerChoices(context, options)
      .catch((error) => ({ winnerByMarket: new Map<string, number>(), ...failed(error, "TORII_UNAVAILABLE", "Market payout enumeration failed; fight winners are unresolved.", "torii") })),
  ]);
  const winnerChoiceByFight: Record<string, number> = {};
  for (const fight of fights.items) {
    const winnerIndex = winners.winnerByMarket.get(fight.marketId.toString());
    if (winnerIndex !== undefined) winnerChoiceByFight[fight.fightId.toString()] = winnerIndex;
  }
  return {
    fights: fights.items.sort((a, b) => a.fightId === b.fightId ? 0 : a.fightId > b.fightId ? -1 : 1),
    winnerChoiceByFight,
    source: "torii",
    attempts: [...fights.attempts, ...winners.attempts],
    complete: fights.complete && winners.complete,
    warnings: [...fights.warnings, ...winners.warnings],
  };
}

async function readBuys(context: RepositoryContext, options: RequestOptions): Promise<BuysRead> {
  if (!context.torii) {
    return { buys: [], ...failed(undefined, "ANALYTICS_BUYS_UNAVAILABLE", "Torii is unavailable, so buy history is not part of this snapshot.", "torii") };
  }
  try {
    const response = await context.torii.sql(FIGHT_BUYS_SQL, options);
    return { buys: response.data.map(mapSqlFightBuy), attempts: response.attempts, complete: true, warnings: [] };
  } catch (error) {
    return { buys: [], ...failed(error, "ANALYTICS_BUYS_UNAVAILABLE", "The Torii SQL buy history read failed; other analytics data was retained.", "torii") };
  }
}

export function createAnalyticsRepository(context: RepositoryContext): AnalyticsRepository {
  const repository: AnalyticsRepository = {
    async snapshot(options = {}) {
      const startedAt = context.now();
      const [fights, buys] = await Promise.all([readFights(context, options), readBuys(context, options)]);
      const complete = fights.complete && buys.complete;
      const warnings = [...fights.warnings, ...buys.warnings];
      if (!complete) {
        warnings.push({ code: "ANALYTICS_PARTIAL", message: "Analytics are partial because one or more reads could not be completed.", source: fights.source });
      }
      return createDataResult({
        data: { fights: fights.fights, buys: buys.buys, winnerChoiceByFight: fights.winnerChoiceByFight },
        source: fights.source,
        complete,
        attempts: [...fights.attempts, ...buys.attempts],
        warnings,
        startedAt,
        now: context.now,
        ...(context.logger ? { logger: context.logger } : {}),
      });
    },
    async summary(filter = {}, options = {}) {
      const startedAt = context.now();
      const snapshot = await repository.snapshot(options);
      return createDataResult({
        data: summarizeAnalyticsSnapshot(snapshot.data, filter),
        source: "derived",
        complete: snapshot.meta.complete,
        attempts: snapshot.meta.attempts,
        warnings: snapshot.meta.warnings,
        startedAt,
        now: context.now,
        ...(snapshot.meta.blockNumber === undefined ? {} : { blockNumber: snapshot.meta.blockNumber }),
        ...(context.logger ? { logger: context.logger } : {}),
      });
    },
  };
  return repository;
}
