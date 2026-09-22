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
 * Every FightBuy in one SQL read, grouped by buyer. Torii stores felts as
 * zero-padded hex and does not compress responses, so one JSON row per buy is
 * ~210 bytes (6.1 MB for 29k buys on mainnet, 2026-09-22). Trimming the
 * padding and writing each buyer once packs the same rows into ~0.56 MB:
 * `b` is the buyer's hex without 0x, `p` is space-separated
 * `fight.choice.boughtAt` entries (hex, no 0x).
 */
export const FIGHT_BUYS_SQL = "SELECT ltrim(substr(buyer, 3), '0') AS b, "
  + "group_concat(ltrim(substr(fight_id, 3), '0') || '.' || choice_index || '.' || ltrim(substr(bought_at, 3), '0'), ' ') AS p "
  + 'FROM "pm-FightBuy" GROUP BY buyer';

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

/** `ltrim` leaves an empty string for zero; restore the 0x prefix either way. */
function trimmedHex(value: string | undefined, label: string): bigint {
  return scalarBigInt(`0x${value || "0"}`, label);
}

export function mapSqlFightBuys(row: Record<string, unknown>): AnalyticsBuy[] {
  const buyer = normalizeAddress(`0x${String(row.b ?? "") || "0"}`);
  return String(row.p ?? "").split(" ").filter(Boolean).map((entry) => {
    const [fightId, choiceIndex, boughtAt] = entry.split(".");
    return {
      fightId: trimmedHex(fightId, "fight_id"),
      buyer,
      choiceIndex: scalarNumber(choiceIndex, "choice_index"),
      boughtAt: trimmedHex(boughtAt, "bought_at"),
    };
  });
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
    return { buys: response.data.flatMap(mapSqlFightBuys), attempts: response.attempts, complete: true, warnings: [] };
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
