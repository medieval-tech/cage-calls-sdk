import { createDataResult, resolveRequestBudget } from "./core.js";
import { summarizeAnalyticsSnapshot, type AnalyticsSummaryFilter, type CageCallsAnalyticsSummary } from "./analyticsSummary.js";
import { encodeU256, normalizeAddress } from "./codecs.js";
import {
  decodeFightBuysRpc,
  decodeSingleNumber,
  mapToriiFight,
  mapToriiFightBuy,
  mapToriiFightWinner,
} from "./decoders.js";
import { AllSourcesFailedError } from "./errors.js";
import { createFightsRepository, type RepositoryContext } from "./repositories.js";
import { readAllToriiModels, type ToriiModelRead } from "./torii-models.js";
import { transportAttemptsFromError } from "./transports.js";
import type {
  AnalyticsSnapshot,
  DataResult,
  DataWarning,
  Fight,
  FightBuy,
  FightWinner,
  RequestOptions,
  SourceAttempt,
} from "./types.js";

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
      message: `${model} analytics enumeration failed and will be recovered through RPC where possible.`,
      source: "torii",
    }],
  };
}

function buyKey(buy: FightBuy): string {
  return `${buy.fightId}:${normalizeAddress(buy.buyer)}`;
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
        message: `Fight ${fightId} has conflicting indexed winner choices; the aggregate fight RPC view will be authoritative.`,
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
      const budget = resolveRequestBudget(context.budget, options);
      const toriiReads = context.torii
        ? await Promise.all([
            readAllToriiModels(context, { model: "Fight", selection: FIGHT_SELECTION }, mapToriiFight, options)
              .catch((error) => unavailableRead<Fight>("Fight", error)),
            readAllToriiModels(context, { model: "FightBuy", selection: FIGHT_BUY_SELECTION }, mapToriiFightBuy, options)
              .catch((error) => unavailableRead<FightBuy>("FightBuy", error)),
            readAllToriiModels(context, { model: "FightWinner", selection: FIGHT_WINNER_SELECTION }, mapToriiFightWinner, options)
              .catch((error) => unavailableRead<FightWinner>("FightWinner", error)),
          ])
        : [
            unavailableRead<Fight>("Fight", new Error("Torii is not configured.")),
            unavailableRead<FightBuy>("FightBuy", new Error("Torii is not configured.")),
            unavailableRead<FightWinner>("FightWinner", new Error("Torii is not configured.")),
          ] as const;
      const [toriiFights, toriiBuys, toriiWinners] = toriiReads;
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

      if (toriiFights.complete && toriiBuys.complete && toriiWinners.complete && !indexedWinners.conflict) {
        return createDataResult({
          data: { fights: toriiFights.items, buys: toriiBuys.items, winnerChoiceByFight: indexedWinners.choices },
          source: "torii",
          complete: true,
          attempts,
          warnings,
          startedAt,
          now: context.now,
          ...(context.logger ? { logger: context.logger } : {}),
        });
      }

      warnings.push({
        code: "TORII_RPC_RECONCILIATION",
        message: "Incomplete Torii analytics are being reconciled with upgraded aggregate RPC views.",
        source: "starknet-rpc",
      });

      const fightMap = new Map(toriiFights.items.map((fight) => [fight.fightId.toString(), fight]));
      const buyMap = new Map(toriiBuys.items.map((buy) => [buyKey(buy), buy]));
      const choices = { ...indexedWinners.choices };
      const fights = createFightsRepository(context);
      let rpcPages = 0;
      let rpcItems = 0;
      let rpcUsed = false;
      let rpcFeedSucceeded = false;
      let rpcFeedComplete = false;
      let rpcBuyComplete = toriiBuys.complete;
      let pageLimitWarned = false;
      let itemLimitWarned = false;

      const warnRpcLimit = (cursor: string) => {
        if (rpcItems >= budget.maxRpcItems && !itemLimitWarned) {
          itemLimitWarned = true;
          warnings.push({
            code: "RPC_ITEM_LIMIT",
            message: `Analytics RPC recovery reached the ${budget.maxRpcItems} item budget at ${cursor}.`,
            source: "starknet-rpc",
          });
        } else if (rpcPages >= budget.maxRpcPages && !pageLimitWarned) {
          pageLimitWarned = true;
          warnings.push({
            code: "RPC_PAGE_LIMIT",
            message: `Analytics RPC recovery reached the ${budget.maxRpcPages} page budget at ${cursor}.`,
            source: "starknet-rpc",
          });
        }
      };

      const needFightFeed = !toriiFights.complete || !toriiWinners.complete || indexedWinners.conflict;
      if (needFightFeed) {
        let cursor = 0n;
        const seen = new Set<bigint>();
        let pageComplete = true;
        try {
          while (rpcPages < budget.maxRpcPages && rpcItems < budget.maxRpcItems) {
            const response = await fights.feed({ limit: 20, cursor }, options);
            rpcUsed = true;
            rpcFeedSucceeded = true;
            rpcPages += 1;
            attempts.push(...response.meta.attempts);
            warnings.push(...response.meta.warnings);
            pageComplete &&= response.meta.complete;
            for (const item of response.data.items) {
              if (rpcItems >= budget.maxRpcItems) break;
              rpcItems += 1;
              fightMap.set(item.fightId.toString(), item);
              if (item.pot.settled && item.pot.winnerIndex !== undefined) choices[item.fightId.toString()] = item.pot.winnerIndex;
              else delete choices[item.fightId.toString()];
            }
            if (!response.data.hasMore) {
              rpcFeedComplete = pageComplete;
              break;
            }
            const nextCursor = response.data.cursor ?? 0n;
            if (nextCursor === cursor || seen.has(nextCursor)) {
              warnings.push({
                code: "RPC_CURSOR_STALLED",
                message: `Fight analytics pagination stopped at repeated cursor ${nextCursor}.`,
                source: "starknet-rpc",
              });
              break;
            }
            seen.add(nextCursor);
            cursor = nextCursor;
          }
          if (!rpcFeedComplete) warnRpcLimit(`fight cursor ${cursor}`);
        } catch (error) {
          attempts.push(...transportAttemptsFromError(error));
          warnings.push({
            code: "RPC_FIGHT_RECOVERY_FAILED",
            message: `Fight analytics RPC recovery failed after ${rpcPages} page(s); indexed fights were retained.`,
            source: "starknet-rpc",
          });
        }
      }

      const fightCoverageComplete = toriiFights.complete || rpcFeedComplete;
      const winnerCoverageComplete = (!indexedWinners.conflict && toriiWinners.complete) || rpcFeedComplete;

      if (!toriiBuys.complete) {
        rpcBuyComplete = fightCoverageComplete;
        for (const fight of fightMap.values()) {
          if (rpcPages >= budget.maxRpcPages || rpcItems >= budget.maxRpcItems) {
            rpcBuyComplete = false;
            warnRpcLimit(`fight ${fight.fightId}`);
            break;
          }
          const indexedForFight = Array.from(buyMap.values()).filter((buy) => buy.fightId === fight.fightId);
          let total: number;
          try {
            const count = await context.rpc.call({
              contractAddress: context.network.contracts.FightFactory,
              entrypoint: "fight_buy_count",
              calldata: encodeU256(fight.fightId),
            }, options);
            rpcUsed = true;
            attempts.push(...count.attempts);
            total = decodeSingleNumber(count.data, "fightBuyCount");
          } catch (error) {
            attempts.push(...transportAttemptsFromError(error));
            warnings.push({
              code: "RPC_BUY_COUNT_FAILED",
              message: `Fight ${fight.fightId} buy count could not be verified; indexed buys were retained.`,
              source: "starknet-rpc",
            });
            rpcBuyComplete = false;
            continue;
          }

          if (indexedForFight.length === total) continue;
          const recovered: FightBuy[] = [];
          let offset = 0;
          let fightComplete = true;
          while (offset < total) {
            if (rpcPages >= budget.maxRpcPages || rpcItems >= budget.maxRpcItems) {
              fightComplete = false;
              warnRpcLimit(`fight ${fight.fightId} buy offset ${offset}`);
              break;
            }
            try {
              const response = await context.rpc.call({
                contractAddress: context.network.contracts.FightFactory,
                entrypoint: "get_fight_buys",
                calldata: [...encodeU256(fight.fightId), offset.toString(), Math.min(100, total - offset).toString()],
              }, options);
              rpcUsed = true;
              rpcPages += 1;
              attempts.push(...response.attempts);
              const rows = decodeFightBuysRpc(response.data);
              const remaining = budget.maxRpcItems - rpcItems;
              recovered.push(...rows.slice(0, remaining));
              rpcItems += Math.min(rows.length, remaining);
              if (rows.length === 0) {
                fightComplete = false;
                warnings.push({
                  code: "RPC_CURSOR_STALLED",
                  message: `Fight ${fight.fightId} buy pagination returned no rows at offset ${offset} before count ${total}.`,
                  source: "starknet-rpc",
                });
                break;
              }
              offset += rows.length;
            } catch (error) {
              attempts.push(...transportAttemptsFromError(error));
              warnings.push({
                code: "RPC_BUY_RECOVERY_FAILED",
                message: `Fight ${fight.fightId} buy recovery failed at offset ${offset}; indexed and recovered rows were retained.`,
                source: "starknet-rpc",
              });
              fightComplete = false;
              break;
            }
          }
          if (fightComplete && recovered.length === total) {
            for (const buy of indexedForFight) buyMap.delete(buyKey(buy));
          } else {
            rpcBuyComplete = false;
          }
          for (const buy of recovered) buyMap.set(buyKey(buy), buy);
        }
      }

      const complete = fightCoverageComplete && winnerCoverageComplete && rpcBuyComplete;
      if (!complete && fightMap.size === 0 && buyMap.size === 0 && needFightFeed && !rpcFeedSucceeded) {
        throw new AllSourcesFailedError("analytics.snapshot", attempts);
      }

      return createDataResult({
        data: {
          fights: Array.from(fightMap.values()).sort((a, b) => a.fightId > b.fightId ? -1 : 1),
          buys: Array.from(buyMap.values()),
          winnerChoiceByFight: choices,
        },
        source: rpcUsed ? "starknet-rpc" : "torii",
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
