import { normalizeAddress, normalizeU256, sameAddress } from "../core/codecs.js";
import { mapToriiFight, mapToriiFightBuy, mapToriiFightWinner, mapToriiMarket, scalarBigInt, scalarNumber } from "../core/decoders.js";
import { deriveFightOddsSeries } from "../core/odds.js";
import { strikeTicketsBase } from "../core/quote.js";
import { createDataResult } from "../core/request.js";
import type { Address, DataResult, DataWarning, FightBuy, FightFeedItem, FightWinner, Market, RequestOptions, SourceAttempt } from "../core/types.js";
import { readAllToriiModels, type ToriiModelRead } from "../transports/torii-models.js";
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

/**
 * scope "market" (default) hydrates full market aggregates: every FightBuy,
 * FightWinner, and MarketBuy row for the requested fights.
 *
 * scope "viewer" restricts the heavy reads to rows the viewer can act on —
 * FightBuy by buyer, FightWinner by winner, MarketBuy skipped entirely.
 * Everything a viewer needs to act stays exact: fight/market metadata, vaults,
 * `pot.winnerIndex`/`settled` (from payouts), and the viewer's own buy/redeem
 * state including `isWinner`. Cross-account aggregates are NOT computed —
 * `pot.total`, `pot.claimed`, and `winnersCount` are explicitly zeroed (never
 * garbage math over partial rows), `outcomeCounts`/`outcomeShares` hold only
 * the viewer's rows, and `oddsSeries` is omitted. `previewStrikeTickets` stays
 * exact for locked-odds fights in both scopes (it only needs the viewer's own
 * shares) and is zeroed in viewer scope for legacy fights, whose claim math
 * divides by ALL winner shares. An account's portfolio spans its whole betting
 * history, so market scope grows with GLOBAL buy volume; viewer scope stays
 * proportional to the account's own activity.
 */
export async function readToriiFightSnapshots(
  context: RepositoryContext,
  fightIds: readonly bigint[],
  viewerInput: Address,
  options: RequestOptions = {},
  scope: "market" | "viewer" = "market",
): Promise<DataResult<FightFeedItem[]>> {
  if (!context.torii) throw new Error("Torii is required for indexed fight snapshots.");
  const viewer = normalizeAddress(viewerInput);
  const startedAt = context.now();
  const ids = Array.from(new Set(fightIds.map(String))).map(BigInt);
  if (ids.length === 0) return createDataResult({ data: [], source: "torii", complete: true, attempts: [], warnings: [], startedAt, now: context.now });
  // Set once on-chain and cached, so this is almost always free. 0 = inactive.
  const lockedOddsCutover = await resolveLockedOddsCutover(context, options);
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
  const buyWhere = scope === "viewer" ? { fight_idIN: idFilter, buyerEQ: viewer } : { fight_idIN: idFilter };
  const winnerWhere = scope === "viewer" ? { fight_idIN: idFilter, winnerEQ: viewer } : { fight_idIN: idFilter };
  const [marketRead, vaultNumeratorRead, vaultDenominatorRead, fightBuyRead, fightWinnerRead, marketBuyRead] = await Promise.all([
    readAllToriiModels(context, { model: "Market", selection: MARKET_SELECTION, where: { market_idIN: marketFilter } }, mapToriiMarket, options),
    readAllToriiModels(context, { model: "VaultNumerator", selection: VAULT_NUMERATOR_SELECTION, where: { market_idIN: marketFilter } }, (node): IndexedValue => ({ id: scalarBigInt(node.market_id, "market_id"), index: scalarNumber(node.index, "index"), value: scalarBigInt(node.value, "value") }), options),
    readAllToriiModels(context, { model: "VaultDenominator", selection: VAULT_DENOMINATOR_SELECTION, where: { market_idIN: marketFilter } }, (node): IndexedValue => ({ id: scalarBigInt(node.market_id, "market_id"), value: scalarBigInt(node.value, "value") }), options),
    readAllToriiModels(context, { model: "FightBuy", selection: FIGHT_BUY_SELECTION, where: buyWhere }, mapToriiFightBuy, options),
    readAllToriiModels(context, { model: "FightWinner", selection: FIGHT_WINNER_SELECTION, where: winnerWhere }, mapToriiFightWinner, options),
    // pot.total = Σ of the FightFactory's MarketBuy deposits — but EVERY user
    // buy routes through the FightFactory, so an address filter matches ~every
    // row on these markets (measured: 10.8 MiB for a 58-fight portfolio).
    // Viewer scope zeroes pot.total instead of paying for a full-table sum.
    scope === "viewer"
      ? Promise.resolve({ items: [], attempts: [], complete: true, warnings: [] } as ToriiModelRead<IndexedMarketBuy>)
      : readAllToriiModels(context, { model: "MarketBuy", selection: MARKET_BUY_SELECTION, where: { market_idIN: marketFilter } }, (node): IndexedMarketBuy => ({ marketId: scalarBigInt(node.market_id, "market_id"), account: normalizeAddress(String(node.account_address)), amountIn: scalarBigInt(node.amount_in, "amount_in") }), options),
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
    const payouts = payoutVector(market, payoutRows);
    const payoutDenominator = payoutDenominators.get(conditionKey)?.[0]?.value ?? 0n;
    const buys = buysByFight.get(fightId.toString()) ?? [];
    const vaultDenominator = vaultDenominators.get(marketKey)?.[0]?.value ?? 0n;
    const validWinnerIndex = settledWinnerIndex(market, payouts, payoutDenominator);
    const settled = (market.resolvedAt ?? 0n) > 0n || payoutDenominator > 0n;
    const outcomeCounts = Array.from({ length: outcomeCount }, (_, index) => BigInt(buys.filter((buy) => buy.choiceIndex === index).length));
    const outcomeShares = Array.from({ length: outcomeCount }, (_, index) => buys.filter((buy) => buy.choiceIndex === index).reduce((sum, buy) => sum + buy.amount, 0n));
    const potTotal = (marketBuysByMarket.get(marketKey) ?? [])
      .filter((buy) => sameAddress(buy.account, context.network.contracts.FightFactory))
      .reduce((sum, buy) => sum + buy.amountIn, 0n);
    const totalWinnerShares = validWinnerIndex === undefined || validWinnerIndex === 2 ? 0n : outcomeShares[validWinnerIndex] ?? 0n;
    const winnerRows = winnersByFight.get(fightId.toString()) ?? [];
    const lockedOdds = isLockedOddsFight(lockedOddsCutover, fightId);
    // Locked-odds fights pay the locked shares directly; legacy fights
    // renormalize to the pot across all winner shares.
    const claimFor = (buy: FightBuy | undefined) => {
      if (!buy) return 0n;
      if (lockedOdds) return buy.amount;
      return totalWinnerShares > 0n ? buy.amount * potTotal / totalWinnerShares : 0n;
    };
    // Locked-odds fights burn the whole pot at settle (fight_pot_claimed jumps
    // to pot_total); legacy fights claim per redemption. Viewer scope zeroes
    // both — its potTotal is 0 and legacy math divides by ALL winner shares.
    const claimed = scope === "viewer" ? 0n : lockedOdds ? (settled ? potTotal : 0n) : winnerRows.reduce((sum, winner) => {
      if (!winner.redeemed) return sum;
      return sum + claimFor(buys.find((buy) => sameAddress(buy.buyer, winner.winner)));
    }, 0n);
    const viewerBuy = buys.find((buy) => sameAddress(buy.buyer, viewer));
    const viewerWinner = winnerRows.find((winner) => sameAddress(winner.winner, viewer));
    const isWinner = Boolean(viewerBuy && validWinnerIndex !== undefined && validWinnerIndex !== 2 && viewerBuy.choiceIndex === validWinnerIndex);
    // Locked-odds previews need only the viewer's own shares, so they stay
    // exact in viewer scope; legacy previews divide by ALL winner shares and
    // are zeroed there instead of running garbage math over partial rows.
    const previewStrikeTickets = !isWinner ? 0n
      : lockedOdds ? strikeTicketsBase(viewerBuy?.amount ?? 0n)
      : scope === "viewer" ? 0n
      : strikeTicketsBase(claimFor(viewerBuy));
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
      ...(scope === "market" && fightBuyRead.complete ? {
        oddsSeries: deriveFightOddsSeries({
          buys,
          vaultNumerators: vaults,
          vaultDenominator,
          createdAt: fight.createdAt,
        }),
      } : {}),
      payoutNumerators: payouts,
      payoutDenominator,
      pot: {
        total: potTotal,
        claimed,
        ...(validWinnerIndex === undefined ? {} : { winnerIndex: validWinnerIndex }),
        winnersCount: scope === "viewer" || validWinnerIndex === undefined || validWinnerIndex === 2 ? 0n : outcomeCounts[validWinnerIndex] ?? 0n,
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
