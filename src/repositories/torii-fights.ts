import { normalizeAddress, normalizeU256, sameAddress } from "../core/codecs.js";
import { mapToriiFight, mapToriiFightBuy, mapToriiFightWinner, mapToriiMarket, scalarBigInt, scalarNumber } from "../core/decoders.js";
import { createDataResult } from "../core/request.js";
import type { Address, DataResult, DataWarning, FightBuy, FightFeedItem, FightWinner, Market, RequestOptions, SourceAttempt } from "../core/types.js";
import { readAllToriiModels, type ToriiModelRead } from "../transports/torii-models.js";
import type { RepositoryContext } from "./index.js";

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
const MARKET_BUY_SELECTION = ["market_id", "outcome_index", "account_address", "amount_in"] as const;

interface IndexedValue {
  id: bigint;
  index?: number;
  value: bigint;
}

interface IndexedMarketBuy {
  marketId: bigint;
  account: Address;
  amountIn: bigint;
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

function strikeTicketsForClaim(claimable: bigint): bigint {
  if (claimable <= 0n) return 0n;
  const whole = claimable / 1_000_000_000_000_000_000n;
  const amount = whole === 0n ? 1n : whole;
  return amount > 10n ? 10n : amount;
}

function attempts(reads: readonly ToriiModelRead<unknown>[]): SourceAttempt[] {
  return reads.flatMap((read) => read.attempts);
}

function warnings(reads: readonly ToriiModelRead<unknown>[]): DataWarning[] {
  return reads.flatMap((read) => read.warnings);
}

export async function readToriiFightSnapshots(
  context: RepositoryContext,
  fightIds: readonly bigint[],
  viewerInput: Address,
  options: RequestOptions = {},
): Promise<DataResult<FightFeedItem[]>> {
  if (!context.torii) throw new Error("Torii is required for indexed fight snapshots.");
  const startedAt = context.now();
  const ids = Array.from(new Set(fightIds.map(String))).map(BigInt);
  if (ids.length === 0) return createDataResult({ data: [], source: "torii", complete: true, attempts: [], warnings: [], startedAt, now: context.now });
  const idFilter = ids.map((fightId) => normalizeU256(fightId, "fightId"));
  const fightRead = await readAllToriiModels(context, {
    model: "Fight",
    selection: FIGHT_SELECTION,
    where: { fight_idIN: idFilter },
  }, mapToriiFight, options);
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
  const [marketRead, vaultNumeratorRead, vaultDenominatorRead, fightBuyRead, fightWinnerRead, marketBuyRead] = await Promise.all([
    readAllToriiModels(context, { model: "Market", selection: MARKET_SELECTION, where: { market_idIN: marketFilter } }, mapToriiMarket, options),
    readAllToriiModels(context, { model: "VaultNumerator", selection: VAULT_NUMERATOR_SELECTION, where: { market_idIN: marketFilter } }, (node): IndexedValue => ({ id: scalarBigInt(node.market_id, "market_id"), index: scalarNumber(node.index, "index"), value: scalarBigInt(node.value, "value") }), options),
    readAllToriiModels(context, { model: "VaultDenominator", selection: VAULT_DENOMINATOR_SELECTION, where: { market_idIN: marketFilter } }, (node): IndexedValue => ({ id: scalarBigInt(node.market_id, "market_id"), value: scalarBigInt(node.value, "value") }), options),
    readAllToriiModels(context, { model: "FightBuy", selection: FIGHT_BUY_SELECTION, where: { fight_idIN: idFilter } }, mapToriiFightBuy, options),
    readAllToriiModels(context, { model: "FightWinner", selection: FIGHT_WINNER_SELECTION, where: { fight_idIN: idFilter } }, mapToriiFightWinner, options),
    readAllToriiModels(context, { model: "MarketBuy", selection: MARKET_BUY_SELECTION, where: { market_idIN: marketFilter } }, (node): IndexedMarketBuy => ({ marketId: scalarBigInt(node.market_id, "market_id"), account: normalizeAddress(String(node.account_address)), amountIn: scalarBigInt(node.amount_in, "amount_in") }), options),
  ]);
  const conditionIds = marketRead.items.map((market) => market.conditionId);
  const conditionFilter = conditionIds.map((conditionId) => normalizeU256(conditionId, "conditionId"));
  const [payoutNumeratorRead, payoutDenominatorRead] = await Promise.all([
    readAllToriiModels(context, { model: "PayoutNumerator", selection: PAYOUT_NUMERATOR_SELECTION, where: { condition_idIN: conditionFilter } }, (node): IndexedValue => ({ id: scalarBigInt(node.condition_id, "condition_id"), index: scalarNumber(node.index, "index"), value: scalarBigInt(node.value, "value") }), options),
    readAllToriiModels(context, { model: "PayoutDenominator", selection: PAYOUT_DENOMINATOR_SELECTION, where: { condition_idIN: conditionFilter } }, (node): IndexedValue => ({ id: scalarBigInt(node.condition_id, "condition_id"), value: scalarBigInt(node.value, "value") }), options),
  ]);

  const allReads: ToriiModelRead<unknown>[] = [fightRead, marketRead, vaultNumeratorRead, vaultDenominatorRead, fightBuyRead, fightWinnerRead, marketBuyRead, payoutNumeratorRead, payoutDenominatorRead];
  const marketById = new Map(marketRead.items.map((market) => [market.marketId.toString(), market]));
  const vaultNumerators = valuesById(vaultNumeratorRead.items);
  const vaultDenominators = valuesById(vaultDenominatorRead.items);
  const payoutNumerators = valuesById(payoutNumeratorRead.items);
  const payoutDenominators = valuesById(payoutDenominatorRead.items);
  const buysByFight = new Map<string, FightBuy[]>();
  for (const buy of fightBuyRead.items) {
    const key = buy.fightId.toString();
    const rows = buysByFight.get(key) ?? [];
    rows.push(buy);
    buysByFight.set(key, rows);
  }
  const winnersByFight = new Map<string, FightWinner[]>();
  for (const winner of fightWinnerRead.items) {
    const key = winner.fightId.toString();
    const rows = winnersByFight.get(key) ?? [];
    rows.push(winner);
    winnersByFight.set(key, rows);
  }
  const marketBuysByMarket = new Map<string, IndexedMarketBuy[]>();
  for (const buy of marketBuyRead.items) {
    const key = buy.marketId.toString();
    const rows = marketBuysByMarket.get(key) ?? [];
    rows.push(buy);
    marketBuysByMarket.set(key, rows);
  }

  const viewer = normalizeAddress(viewerInput);
  const now = BigInt(Math.floor(context.now() / 1_000));
  const missing: bigint[] = [];
  const snapshots = ids.flatMap((fightId): FightFeedItem[] => {
    const fight = fightRead.items.find((value) => value.fightId === fightId);
    const market: Market | undefined = fight ? marketById.get(fight.marketId.toString()) : undefined;
    if (!fight || !market) {
      missing.push(fightId);
      return [];
    }
    const outcomeCount = market.outcomeSlotCount;
    const marketKey = market.marketId.toString();
    const conditionKey = market.conditionId.toString();
    const vaultRows = vaultNumerators.get(marketKey) ?? [];
    const payoutRows = payoutNumerators.get(conditionKey) ?? [];
    const vaults = Array.from({ length: outcomeCount }, (_, index) => vaultRows.find((row) => row.index === index)?.value ?? 0n);
    const payouts = Array.from({ length: outcomeCount }, (_, index) => payoutRows.find((row) => row.index === index)?.value ?? 0n);
    const payoutDenominator = payoutDenominators.get(conditionKey)?.[0]?.value ?? 0n;
    const buys = buysByFight.get(fightId.toString()) ?? [];
    const winnerIndex = payouts.findIndex((value) => value > 0n);
    const settled = (market.resolvedAt ?? 0n) > 0n || payoutDenominator > 0n;
    const validWinnerIndex = settled && winnerIndex >= 0 ? winnerIndex : undefined;
    const outcomeCounts = Array.from({ length: outcomeCount }, (_, index) => BigInt(buys.filter((buy) => buy.choiceIndex === index).length));
    const outcomeShares = Array.from({ length: outcomeCount }, (_, index) => buys.filter((buy) => buy.choiceIndex === index).reduce((sum, buy) => sum + buy.amount, 0n));
    const potTotal = (marketBuysByMarket.get(marketKey) ?? [])
      .filter((buy) => sameAddress(buy.account, context.network.contracts.FightFactory))
      .reduce((sum, buy) => sum + buy.amountIn, 0n);
    const totalWinnerShares = validWinnerIndex === undefined || validWinnerIndex === 2 ? 0n : outcomeShares[validWinnerIndex] ?? 0n;
    const winnerRows = winnersByFight.get(fightId.toString()) ?? [];
    const claimFor = (buy: FightBuy | undefined) => buy && totalWinnerShares > 0n ? buy.amount * potTotal / totalWinnerShares : 0n;
    const claimed = winnerRows.reduce((sum, winner) => {
      if (!winner.redeemed) return sum;
      return sum + claimFor(buys.find((buy) => sameAddress(buy.buyer, winner.winner)));
    }, 0n);
    const viewerBuy = buys.find((buy) => sameAddress(buy.buyer, viewer));
    const viewerWinner = winnerRows.find((winner) => sameAddress(winner.winner, viewer));
    const isWinner = Boolean(viewerBuy && validWinnerIndex !== undefined && validWinnerIndex !== 2 && viewerBuy.choiceIndex === validWinnerIndex);
    const previewStrikeTickets = isWinner ? strikeTicketsForClaim(claimFor(viewerBuy)) : 0n;
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
      vaultDenominator: vaultDenominators.get(marketKey)?.[0]?.value ?? 0n,
      outcomeCounts,
      outcomeShares,
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
    attempts: attempts(allReads),
    warnings: readWarnings,
    startedAt,
    now: context.now,
    ...(context.logger ? { logger: context.logger } : {}),
  });
}
