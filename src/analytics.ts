import { createDataResult } from "./core.js";
import { mapToriiFight, mapToriiFightBuy, mapToriiFightWinner } from "./decoders.js";
import { AllSourcesFailedError, UnsupportedCapabilityError } from "./errors.js";
import type { RepositoryContext } from "./repositories.js";
import { readAllToriiModels } from "./torii-models.js";
import { transportAttemptsFromError } from "./transports.js";
import type { AnalyticsSnapshot, DataResult, DataWarning, RequestOptions } from "./types.js";

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
}

export function createAnalyticsRepository(context: RepositoryContext): AnalyticsRepository {
  return {
    async snapshot(options = {}) {
      if (!context.torii) throw new UnsupportedCapabilityError("analytics snapshot without Torii");
      const startedAt = context.now();
      try {
        const [fights, buys, winners] = await Promise.all([
          readAllToriiModels(context, { model: "Fight", selection: FIGHT_SELECTION }, mapToriiFight, options),
          readAllToriiModels(context, { model: "FightBuy", selection: FIGHT_BUY_SELECTION }, mapToriiFightBuy, options),
          readAllToriiModels(context, { model: "FightWinner", selection: FIGHT_WINNER_SELECTION }, mapToriiFightWinner, options),
        ]);
        const warnings: DataWarning[] = [...fights.warnings, ...buys.warnings, ...winners.warnings];
        const winnerChoiceByFight: Record<string, number> = {};
        for (const winner of winners.items) {
          const fightId = winner.fightId.toString();
          const existing = winnerChoiceByFight[fightId];
          if (existing !== undefined && existing !== winner.choiceIndex) {
            warnings.push({
              code: "WINNER_CHOICE_CONFLICT",
              message: `Fight ${fightId} has conflicting indexed winner choices.`,
              source: "torii",
            });
            continue;
          }
          winnerChoiceByFight[fightId] = winner.choiceIndex;
        }
        return createDataResult({
          data: { fights: fights.items, buys: buys.items, winnerChoiceByFight },
          source: "torii",
          complete: fights.complete && buys.complete && winners.complete && !warnings.some((warning) => warning.code === "WINNER_CHOICE_CONFLICT"),
          attempts: [...fights.attempts, ...buys.attempts, ...winners.attempts],
          warnings,
          startedAt,
          now: context.now,
          ...(context.logger ? { logger: context.logger } : {}),
        });
      } catch (error) {
        throw new AllSourcesFailedError("analytics.snapshot", transportAttemptsFromError(error));
      }
    },
  };
}
