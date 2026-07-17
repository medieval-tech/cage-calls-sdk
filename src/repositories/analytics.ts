import { createDataResult } from "../core/request.js";
import { summarizeAnalyticsSnapshot, type AnalyticsSummaryFilter, type CageCallsAnalyticsSummary } from "./analytics-summary.js";
import {
  mapToriiFight,
  mapToriiFightBuy,
  mapToriiFightWinner,
} from "../core/decoders.js";
import { createFightsRepository, type RepositoryContext } from "./index.js";
import { readAllToriiModels, type ToriiModelRead } from "../transports/torii-models.js";
import { transportAttemptsFromError } from "../transports/index.js";
import type {
  AnalyticsSnapshot,
  DataResult,
  DataWarning,
  Fight,
  FightBuy,
  FightWinner,
  RequestOptions,
  SourceAttempt,
} from "../core/types.js";

const FIGHT_SELECTION = [
  "fight_id", "season_id", "event", "market_id", "fighter_a_id", "fighter_a_name",
  "fighter_a_weight_class", "choice_a_value", "choice_a_label", "fighter_b_id",
  "fighter_b_name", "fighter_b_weight_class", "choice_b_value", "choice_b_label",
  "created_at", "is_dev", "sponsor",
] as const;
const FIGHT_BUY_SELECTION = ["fight_id", "buyer", "market_id", "choice_index", "amount", "bought_at"] as const;
const FIGHT_WINNER_SELECTION = ["fight_id", "winner", "choice_index", "redeemed"] as const;

export interface AnalyticsRepository {
  snapshot(options?: RequestOptions): Promise<DataResult<AnalyticsSnapshot>>;
  summary(filter?: AnalyticsSummaryFilter, options?: RequestOptions): Promise<DataResult<CageCallsAnalyticsSummary>>;
}

function unavailableRead<T>(model: string, error: unknown): ToriiModelRead<T> {
  return {
    items: [],
    attempts: transportAttemptsFromError(error),
    complete: false,
    warnings: [{
      code: "TORII_UNAVAILABLE",
      message: `${model} analytics enumeration failed; other indexed analytics data was retained.`,
      source: "torii",
    }],
  };
}

function winnerChoices(winners: readonly FightWinner[], warnings: DataWarning[]): { choices: Record<string, number>; conflict: boolean } {
  const choices: Record<string, number> = {};
  let conflict = false;
  for (const winner of winners) {
    const fightId = winner.fightId.toString();
    const existing = choices[fightId];
    if (existing !== undefined && existing !== winner.choiceIndex) {
      conflict = true;
      warnings.push({
        code: "WINNER_CHOICE_CONFLICT",
        message: `Fight ${fightId} has conflicting indexed winner choices.`,
        source: "torii",
      });
      continue;
    }
    choices[fightId] = winner.choiceIndex;
  }
  return { choices, conflict };
}

export function createAnalyticsRepository(context: RepositoryContext): AnalyticsRepository {
  const repository: AnalyticsRepository = {
    async snapshot(options = {}) {
      const startedAt = context.now();
      if (!context.torii) {
        const feed = await createFightsRepository(context).feedAll({}, options);
        const winnerChoiceByFight = Object.fromEntries(feed.data.flatMap((fight) =>
          fight.pot.settled && fight.pot.winnerIndex !== undefined
            ? [[fight.fightId.toString(), fight.pot.winnerIndex] as const]
            : []));
        return createDataResult({
          data: { fights: feed.data, buys: [], winnerChoiceByFight },
          source: "starknet-rpc",
          complete: false,
          attempts: feed.meta.attempts,
          warnings: [...feed.meta.warnings, {
            code: "ANALYTICS_BUYS_UNAVAILABLE",
            message: "Torii is unavailable, so buy history was not expanded through per-fight RPC calls.",
            source: "starknet-rpc",
          }],
          startedAt,
          now: context.now,
          ...(context.logger ? { logger: context.logger } : {}),
        });
      }

      const [toriiFights, toriiBuys, toriiWinners] = await Promise.all([
        readAllToriiModels(context, { model: "Fight", selection: FIGHT_SELECTION }, mapToriiFight, options)
          .catch((error) => unavailableRead<Fight>("Fight", error)),
        readAllToriiModels(context, { model: "FightBuy", selection: FIGHT_BUY_SELECTION }, mapToriiFightBuy, options)
          .catch((error) => unavailableRead<FightBuy>("FightBuy", error)),
        readAllToriiModels(context, { model: "FightWinner", selection: FIGHT_WINNER_SELECTION }, mapToriiFightWinner, options)
          .catch((error) => unavailableRead<FightWinner>("FightWinner", error)),
      ]);
      const attempts: SourceAttempt[] = [
        ...toriiFights.attempts,
        ...toriiBuys.attempts,
        ...toriiWinners.attempts,
      ];
      const warnings: DataWarning[] = [
        ...toriiFights.warnings,
        ...toriiBuys.warnings,
        ...toriiWinners.warnings,
      ];
      const indexedWinners = winnerChoices(toriiWinners.items, warnings);
      const complete = toriiFights.complete && toriiBuys.complete && toriiWinners.complete && !indexedWinners.conflict;
      if (!complete) {
        warnings.push({
          code: "TORII_ANALYTICS_PARTIAL",
          message: "Analytics are partial because one or more indexed model reads could not be completed.",
          source: "torii",
        });
      }
      return createDataResult({
        data: {
          fights: toriiFights.items.sort((a, b) => a.fightId === b.fightId ? 0 : a.fightId > b.fightId ? -1 : 1),
          buys: toriiBuys.items,
          winnerChoiceByFight: indexedWinners.choices,
        },
        source: "torii",
        complete,
        attempts,
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
