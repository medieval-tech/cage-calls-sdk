import { normalizeAddress, normalizeU256 } from "../core/codecs.js";
import { mapToriiFight, mapToriiFightBuy, mapToriiFightWinner, mapToriiMarket, scalarBigInt, scalarNumber } from "../core/decoders.js";
import { deriveFightOddsSeries } from "../core/odds.js";
import { strikeTicketsBase } from "../core/quote.js";
import { createDataResult, mapConcurrent, resolveRequestBudget } from "../core/request.js";
import type { Address, DataResult, DataWarning, Fight, FightBuy, FightFeedItem, Market, RequestOptions, SourceAttempt } from "../core/types.js";
import { readAllToriiModels, type ToriiModelRead } from "../transports/torii-models.js";
import { parseTrimmedHex, readU128Sum, sqlChunks, sqlFelt, sqlFelts, sqlTrimmedHex, sqlU128Sum } from "../transports/torii-sql.js";
import type { RepositoryContext } from "./index.js";
import { isLockedOddsFight, resolveLockedOddsCutover } from "./locked-odds.js";

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

interface IndexedValue {
  id: bigint;
  index?: number;
  value: bigint;
}

function valuesById(rows: readonly IndexedValue[]): Map<string, IndexedValue[]> {
  const values = new Map<string, IndexedValue[]>();
  for (const row of rows) {
    const key = row.id.toString();
    const current = values.get(key) ?? [];
    current.push(row);
    values.set(key, current);
  }
  return values;
}

function attempts(reads: readonly ToriiModelRead<unknown>[]): SourceAttempt[] {
  return reads.flatMap((read) => read.attempts);
}

function payoutVector(market: Market, payoutRows: readonly IndexedValue[]): bigint[] {
  return Array.from({ length: market.outcomeSlotCount }, (_, index) => payoutRows.find((row) => row.index === index)?.value ?? 0n);
}

/** The outcome index the market paid out on, once its payout vector is set. */
function settledWinnerIndex(market: Market, payouts: readonly bigint[], payoutDenominator: bigint): number | undefined {
  const winnerIndex = payouts.findIndex((value) => value > 0n);
  const settled = (market.resolvedAt ?? 0n) > 0n || payoutDenominator > 0n;
  return settled && winnerIndex >= 0 ? winnerIndex : undefined;
}

export interface ToriiWinnerChoices {
  /** Winning outcome index per market ID, for every settled market Torii has indexed. */
  winnerByMarket: Map<string, number>;
  attempts: SourceAttempt[];
  complete: boolean;
  warnings: DataWarning[];
}

/**
 * Settled winners for every market from the Market and Payout rows. This is
 * one small page per model, unlike FightWinner, which holds one row per
 * winning bettor and grows with betting volume.
 */
export async function readToriiWinnerChoices(context: RepositoryContext, options: RequestOptions = {}): Promise<ToriiWinnerChoices> {
  const [marketRead, payoutNumeratorRead, payoutDenominatorRead] = await Promise.all([
    readAllToriiModels(context, { model: "Market", selection: MARKET_SELECTION }, mapToriiMarket, options),
    readAllToriiModels(context, { model: "PayoutNumerator", selection: PAYOUT_NUMERATOR_SELECTION }, (node): IndexedValue => ({ id: scalarBigInt(node.condition_id, "condition_id"), index: scalarNumber(node.index, "index"), value: scalarBigInt(node.value, "value") }), options),
    readAllToriiModels(context, { model: "PayoutDenominator", selection: PAYOUT_DENOMINATOR_SELECTION }, (node): IndexedValue => ({ id: scalarBigInt(node.condition_id, "condition_id"), value: scalarBigInt(node.value, "value") }), options),
  ]);
  const reads = [marketRead, payoutNumeratorRead, payoutDenominatorRead];
  const payoutNumerators = valuesById(payoutNumeratorRead.items);
  const payoutDenominators = valuesById(payoutDenominatorRead.items);
  const winnerByMarket = new Map<string, number>();
  for (const market of marketRead.items) {
    const conditionKey = market.conditionId.toString();
    const winnerIndex = settledWinnerIndex(market, payoutVector(market, payoutNumerators.get(conditionKey) ?? []), payoutDenominators.get(conditionKey)?.[0]?.value ?? 0n);
    if (winnerIndex !== undefined) winnerByMarket.set(market.marketId.toString(), winnerIndex);
  }
  return { winnerByMarket, attempts: attempts(reads), complete: reads.every((read) => read.complete), warnings: warnings(reads) };
}

function warnings(reads: readonly ToriiModelRead<unknown>[]): DataWarning[] {
  return reads.flatMap((read) => read.warnings);
}

/** Every fight's buy aggregates, summed by Torii instead of shipping each buy row. */
interface FightBuyTotals {
  counts: bigint[];
  shares: bigint[];
  potTotal: bigint;
  /** Buy timeline for the odds series: one entry per wallet, in chain order. */
  timeline: Array<Pick<FightBuy, "choiceIndex" | "boughtAt">>;
  /** Shares of each redeemed winner on a legacy fight, whose claims round down per buy. */
  redeemedShares: bigint[];
}

async function readToriiFightBuyTotals(
  context: RepositoryContext,
  fights: readonly Fight[],
  lockedOddsCutover: bigint,
  options: RequestOptions,
): Promise<{ totals: Map<string, FightBuyTotals>; attempts: SourceAttempt[] }> {
  const torii = context.torii;
  if (!torii) throw new Error("Torii is required for indexed fight totals.");
  const totals = new Map<string, FightBuyTotals>(fights.map((fight) => [fight.fightId.toString(), { counts: [], shares: [], potTotal: 0n, timeline: [], redeemedShares: [] }]));
  const fightByMarket = new Map(fights.map((fight) => [fight.marketId.toString(), fight.fightId.toString()]));
  const attempts: SourceAttempt[] = [];
  const of = (fightId: unknown) => {
    const entry = totals.get(BigInt(String(fightId)).toString());
    if (!entry) throw new Error(`Torii SQL returned unrequested fight ${String(fightId)}.`);
    return entry;
  };
  const read = async (statement: string) => {
    const response = await torii.sql(statement, options);
    attempts.push(...response.attempts);
    return response.data;
  };
  await mapConcurrent(sqlChunks(fights), resolveRequestBudget(context.budget, options).maxConcurrency, async (chunk) => {
    const ids = sqlFelts(chunk.map((fight) => fight.fightId));
    const legacy = chunk.filter((fight) => !isLockedOddsFight(lockedOddsCutover, fight.fightId));
    const legacyIds = sqlFelts(legacy.map((fight) => fight.fightId));
    const [buyRows, potRows, timelineRows, redeemedRows] = await Promise.all([
      read(`SELECT fight_id, choice_index, COUNT(*) AS n, ${sqlU128Sum("amount", "s")} FROM "pm-FightBuy" WHERE fight_id IN (${ids}) GROUP BY fight_id, choice_index`),
      // pot.total is the FightFactory's MarketBuy deposits: every user buy routes through it.
      read(`SELECT market_id, ${sqlU128Sum("amount_in", "p")} FROM "pm-MarketBuy" WHERE market_id IN (${sqlFelts(chunk.map((fight) => fight.marketId))}) AND account_address = ${sqlFelt(context.network.contracts.FightFactory)} GROUP BY market_id`),
      // Same-second buys replay in block order (the event id starts with the block number).
      read(`SELECT fight_id, group_concat(choice_index || '.' || ${sqlTrimmedHex("bought_at")}, ' ' ORDER BY bought_at, internal_event_id) AS t FROM "pm-FightBuy" WHERE fight_id IN (${ids}) GROUP BY fight_id`),
      legacy.length === 0 ? [] : read(`SELECT fight_id, group_concat(${sqlTrimmedHex("amount")}, ' ') AS a FROM "pm-FightBuy" WHERE fight_id IN (${legacyIds}) AND (fight_id, buyer) IN (SELECT fight_id, winner FROM "pm-FightWinner" WHERE redeemed = 1 AND fight_id IN (${legacyIds})) GROUP BY fight_id`),
    ]);
    for (const row of buyRows) {
      const entry = of(row.fight_id);
      const choice = scalarNumber(row.choice_index, "choice_index");
      entry.counts[choice] = BigInt(Number(row.n));
      entry.shares[choice] = readU128Sum(row, "s");
    }
    for (const row of potRows) {
      const fightId = fightByMarket.get(BigInt(String(row.market_id)).toString());
      if (fightId !== undefined) of(fightId).potTotal = readU128Sum(row, "p");
    }
    for (const row of timelineRows) {
      of(row.fight_id).timeline = String(row.t).split(" ").map((entry) => {
        const [choice = "", boughtAt = ""] = entry.split(".");
        return { choiceIndex: scalarNumber(choice, "choice_index"), boughtAt: parseTrimmedHex(boughtAt) };
      });
    }
    for (const row of redeemedRows) {
      of(row.fight_id).redeemedShares = String(row.a).split(" ").map(parseTrimmedHex);
    }
  });
  return { totals, attempts };
}

/**
 * Feed snapshots for exact fight IDs. Cross-account aggregates (outcome counts and shares,
 * pot, claimed, odds series) are summed by Torii SQL, so the cost grows with the number of
 * fights, not with betting volume; only the viewer's own buy and winner rows are read whole.
 */
export async function readToriiFightSnapshots(
  context: RepositoryContext,
  fightIds: readonly bigint[],
  viewerInput: Address,
  options: RequestOptions = {},
): Promise<DataResult<FightFeedItem[]>> {
  if (!context.torii) throw new Error("Torii is required for indexed fight snapshots.");
  const viewer = normalizeAddress(viewerInput);
  const startedAt = context.now();
  const ids = Array.from(new Set(fightIds.map(String))).map(BigInt);
  if (ids.length === 0) return createDataResult({ data: [], source: "torii", complete: true, attempts: [], warnings: [], startedAt, now: context.now });
  const idFilter = ids.map((fightId) => normalizeU256(fightId, "fightId"));
  const [lockedOddsCutover, fightRead] = await Promise.all([
    // Set once on-chain and cached, so this is almost always free. 0 = inactive.
    resolveLockedOddsCutover(context, options),
    readAllToriiModels(context, { model: "Fight", selection: FIGHT_SELECTION, where: { fight_idIN: idFilter } }, mapToriiFight, options),
  ]);
  const marketIds = Array.from(new Set(fightRead.items.map((fight) => fight.marketId.toString()))).map(BigInt);
  if (marketIds.length === 0) {
    return createDataResult({
      data: [],
      source: "torii",
      complete: false,
      attempts: fightRead.attempts,
      warnings: [
        ...fightRead.warnings,
        { code: "TORII_FIGHT_SNAPSHOT_MISSING", message: `Torii omitted ${ids.length} requested fight snapshot(s).`, source: "torii" },
      ],
      startedAt,
      now: context.now,
      ...(context.logger ? { logger: context.logger } : {}),
    });
  }
  const marketFilter = marketIds.map((marketId) => normalizeU256(marketId, "marketId"));
  const noRows = Promise.resolve({ items: [], attempts: [], complete: true, warnings: [] });
  const hasViewer = BigInt(viewer) !== 0n;
  const [marketRead, vaultNumeratorRead, vaultDenominatorRead, viewerBuyRead, viewerWinnerRead, buyTotals] = await Promise.all([
    readAllToriiModels(context, { model: "Market", selection: MARKET_SELECTION, where: { market_idIN: marketFilter } }, mapToriiMarket, options),
    readAllToriiModels(context, { model: "VaultNumerator", selection: VAULT_NUMERATOR_SELECTION, where: { market_idIN: marketFilter } }, (node): IndexedValue => ({ id: scalarBigInt(node.market_id, "market_id"), index: scalarNumber(node.index, "index"), value: scalarBigInt(node.value, "value") }), options),
    readAllToriiModels(context, { model: "VaultDenominator", selection: VAULT_DENOMINATOR_SELECTION, where: { market_idIN: marketFilter } }, (node): IndexedValue => ({ id: scalarBigInt(node.market_id, "market_id"), value: scalarBigInt(node.value, "value") }), options),
    hasViewer ? readAllToriiModels(context, { model: "FightBuy", selection: FIGHT_BUY_SELECTION, where: { fight_idIN: idFilter, buyerEQ: viewer } }, mapToriiFightBuy, options) : noRows,
    hasViewer ? readAllToriiModels(context, { model: "FightWinner", selection: FIGHT_WINNER_SELECTION, where: { fight_idIN: idFilter, winnerEQ: viewer } }, mapToriiFightWinner, options) : noRows,
    readToriiFightBuyTotals(context, fightRead.items, lockedOddsCutover, options),
  ]);
  const conditionIds = marketRead.items.map((market) => market.conditionId);
  const conditionFilter = conditionIds.map((conditionId) => normalizeU256(conditionId, "conditionId"));
  const [payoutNumeratorRead, payoutDenominatorRead] = await Promise.all([
    readAllToriiModels(context, { model: "PayoutNumerator", selection: PAYOUT_NUMERATOR_SELECTION, where: { condition_idIN: conditionFilter } }, (node): IndexedValue => ({ id: scalarBigInt(node.condition_id, "condition_id"), index: scalarNumber(node.index, "index"), value: scalarBigInt(node.value, "value") }), options),
    readAllToriiModels(context, { model: "PayoutDenominator", selection: PAYOUT_DENOMINATOR_SELECTION, where: { condition_idIN: conditionFilter } }, (node): IndexedValue => ({ id: scalarBigInt(node.condition_id, "condition_id"), value: scalarBigInt(node.value, "value") }), options),
  ]);

  const allReads: ToriiModelRead<unknown>[] = [fightRead, marketRead, vaultNumeratorRead, vaultDenominatorRead, viewerBuyRead, viewerWinnerRead, payoutNumeratorRead, payoutDenominatorRead];
  const marketById = new Map(marketRead.items.map((market) => [market.marketId.toString(), market]));
  const vaultNumerators = valuesById(vaultNumeratorRead.items);
  const vaultDenominators = valuesById(vaultDenominatorRead.items);
  const payoutNumerators = valuesById(payoutNumeratorRead.items);
  const payoutDenominators = valuesById(payoutDenominatorRead.items);
  const viewerBuys = new Map(viewerBuyRead.items.map((buy) => [buy.fightId.toString(), buy]));
  const viewerWinners = new Map(viewerWinnerRead.items.map((winner) => [winner.fightId.toString(), winner]));

  const now = BigInt(Math.floor(context.now() / 1_000));
  const missing: bigint[] = [];
  const snapshots = ids.flatMap((fightId): FightFeedItem[] => {
    const fight = fightRead.items.find((value) => value.fightId === fightId);
    const market: Market | undefined = fight ? marketById.get(fight.marketId.toString()) : undefined;
    const totals = buyTotals.totals.get(fightId.toString());
    if (!fight || !market || !totals) {
      missing.push(fightId);
      return [];
    }
    const outcomeCount = market.outcomeSlotCount;
    const marketKey = market.marketId.toString();
    const conditionKey = market.conditionId.toString();
    const vaultRows = vaultNumerators.get(marketKey) ?? [];
    const payoutRows = payoutNumerators.get(conditionKey) ?? [];
    const vaults = Array.from({ length: outcomeCount }, (_, index) => vaultRows.find((row) => row.index === index)?.value ?? 0n);
    const payouts = payoutVector(market, payoutRows);
    const payoutDenominator = payoutDenominators.get(conditionKey)?.[0]?.value ?? 0n;
    const vaultDenominator = vaultDenominators.get(marketKey)?.[0]?.value ?? 0n;
    const validWinnerIndex = settledWinnerIndex(market, payouts, payoutDenominator);
    const settled = (market.resolvedAt ?? 0n) > 0n || payoutDenominator > 0n;
    const outcomeCounts = Array.from({ length: outcomeCount }, (_, index) => totals.counts[index] ?? 0n);
    const outcomeShares = Array.from({ length: outcomeCount }, (_, index) => totals.shares[index] ?? 0n);
    const potTotal = totals.potTotal;
    const totalWinnerShares = validWinnerIndex === undefined || validWinnerIndex === 2 ? 0n : outcomeShares[validWinnerIndex] ?? 0n;
    const lockedOdds = isLockedOddsFight(lockedOddsCutover, fightId);
    // Locked-odds fights pay the locked shares directly; legacy fights
    // renormalize to the pot across all winner shares, rounding down per buy.
    const claimFor = (shares: bigint) => {
      if (lockedOdds) return shares;
      return totalWinnerShares > 0n ? shares * potTotal / totalWinnerShares : 0n;
    };
    // Locked-odds fights burn the whole pot at settle (fight_pot_claimed jumps
    // to pot_total); legacy fights claim per redemption.
    const claimed = lockedOdds
      ? (settled ? potTotal : 0n)
      : totals.redeemedShares.reduce((sum, shares) => sum + claimFor(shares), 0n);
    const viewerBuy = viewerBuys.get(fightId.toString());
    const viewerWinner = viewerWinners.get(fightId.toString());
    const isWinner = Boolean(viewerBuy && validWinnerIndex !== undefined && validWinnerIndex !== 2 && viewerBuy.choiceIndex === validWinnerIndex);
    const previewStrikeTickets = isWinner && viewerBuy
      ? strikeTicketsBase(lockedOdds ? viewerBuy.amount : claimFor(viewerBuy.amount))
      : 0n;
    const closed = settled || now >= (market.endAt ?? 0n);
    return [{
      ...fight,
      marketCreatedAt: market.createdAt,
      conditionId: market.conditionId,
      oracle: market.oracle,
      outcomeSlotCount: market.outcomeSlotCount,
      collateralToken: market.collateralToken,
      startAt: market.startAt ?? 0n,
      endAt: market.endAt ?? 0n,
      resolveAt: market.resolveAt ?? 0n,
      resolvedAt: market.resolvedAt ?? 0n,
      vaultNumerators: vaults,
      vaultDenominator,
      outcomeCounts,
      outcomeShares,
      lockedOdds,
      oddsSeries: deriveFightOddsSeries({
        buys: totals.timeline,
        vaultNumerators: vaults,
        vaultDenominator,
        createdAt: fight.createdAt,
      }),
      payoutNumerators: payouts,
      payoutDenominator,
      pot: {
        total: potTotal,
        claimed,
        ...(validWinnerIndex === undefined ? {} : { winnerIndex: validWinnerIndex }),
        winnersCount: validWinnerIndex === undefined || validWinnerIndex === 2 ? 0n : outcomeCounts[validWinnerIndex] ?? 0n,
        closed,
        settled,
      },
      viewer: viewerBuy ? {
        hasBought: true,
        choiceIndex: viewerBuy.choiceIndex,
        shares: viewerBuy.amount,
        boughtAt: viewerBuy.boughtAt,
        hasRedeemed: viewerWinner?.redeemed ?? false,
        isWinner,
        previewStrikeTickets,
        strikeTickets: previewStrikeTickets,
      } : {
        hasBought: false,
        shares: 0n,
        boughtAt: 0n,
        hasRedeemed: false,
        isWinner: false,
        previewStrikeTickets: 0n,
        strikeTickets: 0n,
      },
    }];
  });
  const readWarnings = warnings(allReads);
  if (missing.length > 0) readWarnings.push({ code: "TORII_FIGHT_SNAPSHOT_MISSING", message: `Torii omitted ${missing.length} requested fight snapshot(s).`, source: "torii" });
  return createDataResult({
    data: snapshots,
    source: "torii",
    complete: missing.length === 0 && allReads.every((read) => read.complete),
    attempts: [...attempts(allReads), ...buyTotals.attempts],
    warnings: readWarnings,
    startedAt,
    now: context.now,
    ...(context.logger ? { logger: context.logger } : {}),
  });
}
