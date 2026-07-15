import { normalizeAddress } from "./codecs.js";
import type { Address, AnalyticsSnapshot, Fight, FightBuy } from "./types.js";

export interface AnalyticsSummaryFilter {
  from?: bigint;
  to?: bigint;
  fightIds?: readonly bigint[];
  marketIds?: readonly bigint[];
  eventNames?: readonly string[];
  buyers?: readonly Address[];
  productionOnly?: boolean;
}

export interface AnalyticsMetrics {
  predictions: number;
  uniqueWallets: number;
  volume: bigint;
  averageBid: bigint;
  averagePredictionsPerWallet: number;
  repeatWallets: number;
  correct: number;
  wrong: number;
  unresolved: number;
}

export interface AnalyticsDailyPoint {
  day: string;
  predictions: number;
  uniqueWallets: number;
  cumulativeWallets: number;
  volume: bigint;
}

export interface AnalyticsFightSummary {
  fightId: bigint;
  marketId: bigint;
  eventName: string;
  label: string;
  predictions: number;
  uniqueWallets: number;
  volume: bigint;
}

export interface AnalyticsEventSummary {
  eventName: string;
  predictions: number;
  uniqueWallets: number;
  returningWallets: number;
  newWallets: number;
  allFightsWallets: number;
  someFightsWallets: number;
  allFightsPercentage: number;
  someFightsPercentage: number;
  fights: AnalyticsFightSummary[];
}

export interface CageCallsAnalyticsSummary {
  filter: AnalyticsSummaryFilter;
  metrics: AnalyticsMetrics;
  daily: AnalyticsDailyPoint[];
  fights: AnalyticsFightSummary[];
  events: AnalyticsEventSummary[];
  includedFights: Fight[];
  includedBuys: FightBuy[];
}

function uniqueBigInts(values: readonly bigint[] | undefined): bigint[] | undefined {
  return values ? Array.from(new Set(values.map(String))).map(BigInt).sort((a, b) => a < b ? -1 : a > b ? 1 : 0) : undefined;
}

function normalizeFilter(filter: AnalyticsSummaryFilter): AnalyticsSummaryFilter {
  const fightIds = uniqueBigInts(filter.fightIds);
  const marketIds = uniqueBigInts(filter.marketIds);
  const eventNames = filter.eventNames ? Array.from(new Set(filter.eventNames.map((value) => value.trim()).filter(Boolean))).sort() : undefined;
  const buyers = filter.buyers ? Array.from(new Set(filter.buyers.map((buyer) => normalizeAddress(buyer)))).sort() as Address[] : undefined;
  return {
    ...(filter.from !== undefined ? { from: filter.from } : {}),
    ...(filter.to !== undefined ? { to: filter.to } : {}),
    ...(fightIds?.length ? { fightIds } : {}),
    ...(marketIds?.length ? { marketIds } : {}),
    ...(eventNames?.length ? { eventNames } : {}),
    ...(buyers?.length ? { buyers } : {}),
    ...(filter.productionOnly !== undefined ? { productionOnly: filter.productionOnly } : {}),
  };
}

function fightLabel(fight: Fight): string {
  const left = fight.choiceALabel || fight.fighterAName || "Choice A";
  const right = fight.choiceBLabel || fight.fighterBName || "Choice B";
  return `${left} vs ${right}`;
}

function includedFight(fight: Fight, filter: AnalyticsSummaryFilter): boolean {
  if (filter.productionOnly && (fight.isDev || !fight.eventName.trim())) return false;
  if (filter.fightIds && !filter.fightIds.includes(fight.fightId)) return false;
  if (filter.marketIds && !filter.marketIds.includes(fight.marketId)) return false;
  if (filter.eventNames && !filter.eventNames.includes(fight.eventName.trim())) return false;
  return true;
}

function includedBuy(buy: FightBuy, filter: AnalyticsSummaryFilter, fightIds: ReadonlySet<string>): boolean {
  if (!fightIds.has(buy.fightId.toString())) return false;
  if (filter.from !== undefined && buy.boughtAt < filter.from) return false;
  if (filter.to !== undefined && buy.boughtAt > filter.to) return false;
  if (filter.buyers && !filter.buyers.includes(normalizeAddress(buy.buyer))) return false;
  return true;
}

export function summarizeAnalyticsSnapshot(
  snapshot: AnalyticsSnapshot,
  filter: AnalyticsSummaryFilter = {},
): CageCallsAnalyticsSummary {
  const normalizedFilter = normalizeFilter(filter);
  const includedFights = snapshot.fights.filter((fight) => includedFight(fight, normalizedFilter));
  const fightById = new Map(includedFights.map((fight) => [fight.fightId.toString(), fight]));
  const includedFightIds = new Set(fightById.keys());
  const includedBuys = snapshot.buys.filter((buy) => includedBuy(buy, normalizedFilter, includedFightIds));
  const allWallets = new Set<string>();
  const eventWallets = new Map<string, Set<string>>();
  let volume = 0n;
  let correct = 0;
  let wrong = 0;
  let unresolved = 0;

  const fightStats = new Map<string, { fight: Fight; buys: number; wallets: Set<string>; volume: bigint }>();
  const dailyStats = new Map<string, { predictions: number; wallets: Set<string>; volume: bigint }>();
  const eventUserFights = new Map<string, Map<string, Set<string>>>();

  for (const buy of includedBuys) {
    const fight = fightById.get(buy.fightId.toString());
    if (!fight) continue;
    const wallet = normalizeAddress(buy.buyer);
    const eventName = fight.eventName.trim() || "Untitled event";
    allWallets.add(wallet);
    volume += buy.amount;

    const eventUsers = eventWallets.get(eventName) ?? new Set<string>();
    eventUsers.add(wallet);
    eventWallets.set(eventName, eventUsers);

    const usersForFights = eventUserFights.get(eventName) ?? new Map<string, Set<string>>();
    const fightsForUser = usersForFights.get(wallet) ?? new Set<string>();
    fightsForUser.add(fight.fightId.toString());
    usersForFights.set(wallet, fightsForUser);
    eventUserFights.set(eventName, usersForFights);

    const fightEntry = fightStats.get(buy.fightId.toString()) ?? { fight, buys: 0, wallets: new Set<string>(), volume: 0n };
    fightEntry.buys += 1;
    fightEntry.wallets.add(wallet);
    fightEntry.volume += buy.amount;
    fightStats.set(buy.fightId.toString(), fightEntry);

    const day = new Date(Number(buy.boughtAt) * 1000).toISOString().slice(0, 10);
    const dayEntry = dailyStats.get(day) ?? { predictions: 0, wallets: new Set<string>(), volume: 0n };
    dayEntry.predictions += 1;
    dayEntry.wallets.add(wallet);
    dayEntry.volume += buy.amount;
    dailyStats.set(day, dayEntry);

    const winner = snapshot.winnerChoiceByFight[buy.fightId.toString()];
    if (winner === undefined) unresolved += 1;
    else if (winner === buy.choiceIndex) correct += 1;
    else wrong += 1;
  }

  const fights = Array.from(fightStats.values()).map((entry): AnalyticsFightSummary => ({
    fightId: entry.fight.fightId,
    marketId: entry.fight.marketId,
    eventName: entry.fight.eventName.trim() || "Untitled event",
    label: fightLabel(entry.fight),
    predictions: entry.buys,
    uniqueWallets: entry.wallets.size,
    volume: entry.volume,
  })).sort((a, b) => b.predictions - a.predictions || a.label.localeCompare(b.label));

  const seenWallets = new Set<string>();
  const daily = Array.from(dailyStats.entries()).sort(([a], [b]) => a.localeCompare(b)).map(([day, entry]): AnalyticsDailyPoint => {
    for (const wallet of entry.wallets) seenWallets.add(wallet);
    return { day, predictions: entry.predictions, uniqueWallets: entry.wallets.size, cumulativeWallets: seenWallets.size, volume: entry.volume };
  });

  const eventOrder = new Map<string, bigint>();
  const eventFightCounts = new Map<string, number>();
  for (const fight of includedFights) {
    const eventName = fight.eventName.trim() || "Untitled event";
    const existing = eventOrder.get(eventName);
    if (existing === undefined || fight.createdAt < existing) eventOrder.set(eventName, fight.createdAt);
    eventFightCounts.set(eventName, (eventFightCounts.get(eventName) ?? 0) + 1);
  }
  const cumulativeEventWallets = new Set<string>();
  const events = Array.from(eventWallets.entries())
    .sort(([left], [right]) => {
      const a = eventOrder.get(left) ?? 0n;
      const b = eventOrder.get(right) ?? 0n;
      return a < b ? -1 : a > b ? 1 : left.localeCompare(right);
    })
    .map(([eventName, wallets]): AnalyticsEventSummary => {
      const returningWallets = Array.from(wallets).filter((wallet) => cumulativeEventWallets.has(wallet)).length;
      for (const wallet of wallets) cumulativeEventWallets.add(wallet);
      const eventFights = fights.filter((fight) => fight.eventName === eventName);
      const userFights = eventUserFights.get(eventName) ?? new Map<string, Set<string>>();
      const totalFights = eventFightCounts.get(eventName) ?? eventFights.length;
      let allFightsWallets = 0;
      let someFightsWallets = 0;
      for (const values of userFights.values()) {
        if (totalFights > 0 && values.size >= totalFights) allFightsWallets += 1;
        else someFightsWallets += 1;
      }
      const predictions = eventFights.reduce((total, fight) => total + fight.predictions, 0);
      return {
        eventName,
        predictions,
        uniqueWallets: wallets.size,
        returningWallets,
        newWallets: wallets.size - returningWallets,
        allFightsWallets,
        someFightsWallets,
        allFightsPercentage: wallets.size ? (allFightsWallets / wallets.size) * 100 : 0,
        someFightsPercentage: wallets.size ? (someFightsWallets / wallets.size) * 100 : 0,
        fights: eventFights,
      };
    });

  const repeatWallets = Array.from(allWallets).filter((wallet) => {
    let appearances = 0;
    for (const wallets of eventWallets.values()) {
      if (wallets.has(wallet)) appearances += 1;
      if (appearances > 1) return true;
    }
    return false;
  }).length;

  return {
    filter: normalizedFilter,
    metrics: {
      predictions: includedBuys.length,
      uniqueWallets: allWallets.size,
      volume,
      averageBid: includedBuys.length ? volume / BigInt(includedBuys.length) : 0n,
      averagePredictionsPerWallet: allWallets.size ? includedBuys.length / allWallets.size : 0,
      repeatWallets,
      correct,
      wrong,
      unresolved,
    },
    daily,
    fights,
    events,
    includedFights,
    includedBuys,
  };
}
