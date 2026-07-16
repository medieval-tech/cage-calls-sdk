import { CairoReader, decodeShortString, normalizeAddress, normalizeFelt } from "./codecs.js";
import { DecodeError } from "./errors.js";
import type {
  Fight,
  FightBuy,
  FightFeedItem,
  FightWinner,
  Fighter,
  GachaPoolState,
  GachaUserStates,
  Market,
  Relic,
  RelicMetadata,
} from "./types.js";

function readGachaPoolState(reader: CairoReader): GachaPoolState {
  const state: GachaPoolState = {
    fightId: reader.u256("fightId"),
    open: reader.bool("open"),
    size: reader.u256("size"),
    rarities: [],
  };
  const count = reader.number("rarities.length");
  for (let index = 0; index < count; index += 1) {
    state.rarities.push({
      rarity: reader.number("rarity"),
      expected: reader.u256("expected"),
      registered: reader.u256("registered"),
      available: reader.u256("available"),
    });
  }
  return state;
}

export function decodeGachaPoolStateRpc(values: readonly string[]): GachaPoolState {
  const reader = new CairoReader(values, "GachaPoolState");
  const state = readGachaPoolState(reader);
  reader.done();
  return state;
}

export function decodeGachaPoolStatesRpc(values: readonly string[]): GachaPoolState[] {
  const reader = new CairoReader(values, "GachaPoolState[]");
  const count = reader.number("states.length");
  const states = Array.from({ length: count }, () => readGachaPoolState(reader));
  reader.done();
  return states;
}

export function decodeGachaUserStatesRpc(values: readonly string[], user: string): GachaUserStates {
  const reader = new CairoReader(values, "GachaUserStates");
  const strikeNonce = reader.bigint("strikeNonce");
  const count = reader.number("states.length");
  const account = normalizeAddress(user);
  const states = Array.from({ length: count }, () => {
    const pool = readGachaPoolState(reader);
    const ticketBalance = reader.u256("ticketBalance");
    const escrowedTokenId = reader.u256("escrowedToken");
    return {
      fightId: pool.fightId,
      user: account,
      strikeNonce,
      ticketBalance,
      ...(escrowedTokenId === 0n ? {} : { escrowedTokenId }),
      pool,
    };
  });
  reader.done();
  return { user: account, strikeNonce, states };
}

export function scalarBigInt(value: unknown, label = "value"): bigint {
  try {
    if (typeof value === "bigint") return value;
    if (typeof value === "number" || typeof value === "string") return BigInt(value);
    if (value && typeof value === "object") {
      const object = value as Record<string, unknown>;
      if (object.low !== undefined && object.high !== undefined) {
        return BigInt(String(object.low)) + (BigInt(String(object.high)) << 128n);
      }
      if (object.value !== undefined) return scalarBigInt(object.value, label);
    }
  } catch {
    // The typed error below is more useful than a raw BigInt error.
  }
  throw new DecodeError(`${label} is not an integer.`);
}

export function scalarNumber(value: unknown, label = "value"): number {
  const parsed = scalarBigInt(value, label);
  const number = Number(parsed);
  if (!Number.isSafeInteger(number)) throw new DecodeError(`${label} is not a safe integer.`);
  return number;
}

export function scalarBoolean(value: unknown, label = "value"): boolean {
  if (typeof value === "boolean") return value;
  const parsed = scalarBigInt(value, label);
  if (parsed !== 0n && parsed !== 1n) throw new DecodeError(`${label} is not a bool.`);
  return parsed === 1n;
}

export function scalarString(value: unknown, label = "value"): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    if (typeof object.value === "string") return object.value;
  }
  throw new DecodeError(`${label} is not a string.`);
}

export function decodeFighterRpc(values: readonly string[]): Fighter {
  const reader = new CairoReader(values, "Fighter");
  const fighter: Fighter = {
    fighterId: reader.u256("fighterId"),
    name: reader.byteArray("name"),
    weightClass: reader.byteArray("weightClass"),
    active: reader.bool("active"),
  };
  reader.done();
  return fighter;
}

export function decodeFightersRpc(values: readonly string[]): Fighter[] {
  const reader = new CairoReader(values, "Fighter[]");
  const count = reader.number("length");
  const fighters: Fighter[] = [];
  for (let index = 0; index < count; index += 1) {
    fighters.push({
      fighterId: reader.u256("fighterId"),
      name: reader.byteArray("name"),
      weightClass: reader.byteArray("weightClass"),
      active: reader.bool("active"),
    });
  }
  reader.done();
  return fighters;
}

export function mapToriiFighter(value: Record<string, unknown>): Fighter {
  return {
    fighterId: scalarBigInt(value.fighter_id, "fighter_id"),
    name: scalarString(value.name, "name"),
    weightClass: scalarString(value.weight_class, "weight_class"),
    active: scalarBoolean(value.active, "active"),
  };
}

function readFight(reader: CairoReader): Fight {
  return {
    fightId: reader.u256("fightId"),
    seasonId: reader.u256("seasonId"),
    eventName: reader.byteArray("eventName"),
    marketId: reader.u256("marketId"),
    fighterAId: reader.u256("fighterAId"),
    fighterAName: reader.byteArray("fighterAName"),
    fighterAWeightClass: reader.byteArray("fighterAWeightClass"),
    choiceAValue: reader.u256("choiceAValue"),
    choiceALabel: reader.byteArray("choiceALabel"),
    fighterBId: reader.u256("fighterBId"),
    fighterBName: reader.byteArray("fighterBName"),
    fighterBWeightClass: reader.byteArray("fighterBWeightClass"),
    choiceBValue: reader.u256("choiceBValue"),
    choiceBLabel: reader.byteArray("choiceBLabel"),
    createdAt: reader.bigint("createdAt"),
    isDev: reader.bool("isDev"),
    sponsor: normalizeFelt(reader.felt("sponsor")),
  };
}

export function decodeFightRpc(values: readonly string[]): Fight {
  const reader = new CairoReader(values, "Fight");
  const fight = readFight(reader);
  reader.done();
  return fight;
}

export function mapToriiFight(value: Record<string, unknown>): Fight {
  return {
    fightId: scalarBigInt(value.fight_id, "fight_id"),
    seasonId: scalarBigInt(value.season_id, "season_id"),
    eventName: scalarString(value.event, "event"),
    marketId: scalarBigInt(value.market_id, "market_id"),
    fighterAId: scalarBigInt(value.fighter_a_id, "fighter_a_id"),
    fighterAName: scalarString(value.fighter_a_name, "fighter_a_name"),
    fighterAWeightClass: scalarString(value.fighter_a_weight_class, "fighter_a_weight_class"),
    choiceAValue: scalarBigInt(value.choice_a_value, "choice_a_value"),
    choiceALabel: scalarString(value.choice_a_label, "choice_a_label"),
    fighterBId: scalarBigInt(value.fighter_b_id, "fighter_b_id"),
    fighterBName: scalarString(value.fighter_b_name, "fighter_b_name"),
    fighterBWeightClass: scalarString(value.fighter_b_weight_class, "fighter_b_weight_class"),
    choiceBValue: scalarBigInt(value.choice_b_value, "choice_b_value"),
    choiceBLabel: scalarString(value.choice_b_label, "choice_b_label"),
    createdAt: scalarBigInt(value.created_at, "created_at"),
    isDev: scalarBoolean(value.is_dev, "is_dev"),
    sponsor: normalizeFelt(String(value.sponsor ?? "0")),
  };
}

function readFightBuy(reader: CairoReader): FightBuy {
  return {
    fightId: reader.u256("fightId"),
    buyer: reader.address("buyer"),
    marketId: reader.u256("marketId"),
    choiceIndex: reader.number("choiceIndex"),
    amount: reader.u256("amount"),
    boughtAt: reader.bigint("boughtAt"),
  };
}

export function decodeFightBuyRpc(values: readonly string[]): FightBuy {
  const reader = new CairoReader(values, "FightBuy");
  const buy = readFightBuy(reader);
  reader.done();
  return buy;
}

export function decodeFightBuysRpc(values: readonly string[]): FightBuy[] {
  const reader = new CairoReader(values, "FightBuy[]");
  const count = reader.number("length");
  const buys = Array.from({ length: count }, () => readFightBuy(reader));
  reader.done();
  return buys;
}

export function mapToriiFightBuy(value: Record<string, unknown>): FightBuy {
  return {
    fightId: scalarBigInt(value.fight_id, "fight_id"),
    buyer: normalizeAddress(String(value.buyer)),
    marketId: scalarBigInt(value.market_id, "market_id"),
    choiceIndex: scalarNumber(value.choice_index, "choice_index"),
    amount: scalarBigInt(value.amount, "amount"),
    boughtAt: scalarBigInt(value.bought_at, "bought_at"),
  };
}

export function decodeFightWinnerRpc(values: readonly string[]): FightWinner {
  const reader = new CairoReader(values, "FightWinner");
  const winner: FightWinner = {
    fightId: reader.u256("fightId"),
    winner: reader.address("winner"),
    choiceIndex: reader.number("choiceIndex"),
    redeemed: reader.bool("redeemed"),
  };
  reader.done();
  return winner;
}

export function mapToriiFightWinner(value: Record<string, unknown>): FightWinner {
  return {
    fightId: scalarBigInt(value.fight_id, "fight_id"),
    winner: normalizeAddress(String(value.winner)),
    choiceIndex: scalarNumber(value.choice_index, "choice_index"),
    redeemed: scalarBoolean(value.redeemed, "redeemed"),
  };
}

export function decodeFightFeedRpc(values: readonly string[]): FightFeedItem[] {
  const reader = new CairoReader(values, "FightFeedRow[]");
  const count = reader.number("length");
  const items: FightFeedItem[] = [];
  for (let index = 0; index < count; index += 1) {
    const fight: Fight = {
      fightId: reader.u256("fightId"),
      seasonId: reader.u256("seasonId"),
      eventName: reader.byteArray("eventName"),
      marketId: reader.u256("marketId"),
      fighterAId: reader.u256("fighterAId"),
      fighterAName: reader.byteArray("fighterAName"),
      fighterAWeightClass: reader.byteArray("fighterAWeightClass"),
      choiceAValue: reader.u256("choiceAValue"),
      choiceALabel: reader.byteArray("choiceALabel"),
      fighterBId: reader.u256("fighterBId"),
      fighterBName: reader.byteArray("fighterBName"),
      fighterBWeightClass: reader.byteArray("fighterBWeightClass"),
      choiceBValue: reader.u256("choiceBValue"),
      choiceBLabel: reader.byteArray("choiceBLabel"),
      createdAt: reader.bigint("fightCreatedAt"),
      isDev: reader.bool("isDev"),
      sponsor: normalizeFelt(reader.felt("sponsor")),
    };
    const marketCreatedAt = reader.bigint("marketCreatedAt");
    const conditionId = reader.u256("conditionId");
    const oracle = reader.address("oracle");
    const outcomeSlotCount = reader.number("outcomeSlotCount");
    const collateralToken = reader.address("collateralToken");
    const startAt = reader.bigint("startAt");
    const endAt = reader.bigint("endAt");
    const resolveAt = reader.bigint("resolveAt");
    const resolvedAt = reader.bigint("resolvedAt");
    const vaultNumerators = [reader.u256(), reader.u256(), reader.u256()];
    const vaultDenominator = reader.u256("vaultDenominator");
    const outcomeCounts = [reader.u256(), reader.u256(), reader.u256()];
    const outcomeShares = [reader.u256(), reader.u256(), reader.u256()];
    const payoutNumerators = [reader.u256(), reader.u256(), reader.u256()];
    const payoutDenominator = reader.u256("payoutDenominator");
    const closed = reader.bool("fightClosed");
    const settled = reader.bool("fightSettled");
    const winnerIndexValue = reader.number("winnerIndex");
    const winnersCount = reader.u256("winnersCount");
    const total = reader.u256("potTotal");
    const claimed = reader.u256("potClaimed");
    const hasBought = reader.bool("viewerHasBought");
    const viewerChoice = reader.number("viewerChoiceIndex");
    const shares = reader.u256("viewerShares");
    const boughtAt = reader.bigint("viewerBoughtAt");
    const hasRedeemed = reader.bool("viewerHasRedeemed");
    const isWinner = reader.bool("viewerIsWinner");
    const strikeTickets = reader.u256("viewerStrikeTickets");
    items.push({
      ...fight,
      marketCreatedAt,
      conditionId,
      oracle,
      outcomeSlotCount,
      collateralToken,
      startAt,
      endAt,
      resolveAt,
      resolvedAt,
      vaultNumerators,
      vaultDenominator,
      outcomeCounts,
      outcomeShares,
      payoutNumerators,
      payoutDenominator,
      pot: {
        total,
        claimed,
        ...(winnerIndexValue === 255 ? {} : { winnerIndex: winnerIndexValue }),
        winnersCount,
        closed,
        settled,
      },
      viewer: {
        hasBought,
        ...(viewerChoice === 255 ? {} : { choiceIndex: viewerChoice }),
        shares,
        boughtAt,
        hasRedeemed,
        isWinner,
        strikeTickets,
      },
    });
  }
  reader.done();
  return items;
}

export function decodeMarketRpc(values: readonly string[]): Market {
  const reader = new CairoReader(values, "Market");
  const marketId = reader.u256("marketId");
  const creator = reader.address("creator");
  const createdAt = reader.bigint("createdAt");
  const questionId = reader.u256("questionId");
  const conditionId = reader.u256("conditionId");
  const oracle = reader.address("oracle");
  const outcomeSlotCount = reader.number("outcomeSlotCount");
  const collateralToken = reader.address("collateralToken");
  return { marketId, creator, createdAt, questionId, conditionId, oracle, outcomeSlotCount, collateralToken };
}

export function mapToriiMarket(value: Record<string, unknown>): Market {
  const market: Market = {
    marketId: scalarBigInt(value.market_id, "market_id"),
    creator: normalizeAddress(String(value.creator)),
    createdAt: scalarBigInt(value.created_at, "created_at"),
    conditionId: scalarBigInt(value.condition_id, "condition_id"),
    oracle: normalizeAddress(String(value.oracle)),
    outcomeSlotCount: scalarNumber(value.outcome_slot_count, "outcome_slot_count"),
    collateralToken: normalizeAddress(String(value.collateral_token)),
  };
  if (value.question_id !== undefined) market.questionId = scalarBigInt(value.question_id, "question_id");
  if (value.start_at !== undefined) market.startAt = scalarBigInt(value.start_at, "start_at");
  if (value.end_at !== undefined) market.endAt = scalarBigInt(value.end_at, "end_at");
  if (value.resolve_at !== undefined) market.resolveAt = scalarBigInt(value.resolve_at, "resolve_at");
  if (value.resolved_at !== undefined) market.resolvedAt = scalarBigInt(value.resolved_at, "resolved_at");
  return market;
}

function readRelicMetadata(reader: CairoReader): RelicMetadata {
  return {
    definitionId: reader.u256("definitionId"),
    seasonId: reader.u256("seasonId"),
    fightId: reader.u256("fightId"),
    fighterId: reader.u256("fighterId"),
    opponentId: reader.u256("opponentId"),
    sponsor: decodeShortString(reader.felt("sponsor")),
    relicIndex: reader.number("relicIndex"),
    fightTimestamp: reader.bigint("fightTimestamp"),
    mediaUri: decodeShortString(reader.felt("mediaUri")),
    mediaType: reader.number("mediaType"),
    category: reader.number("category"),
    moveType: decodeShortString(reader.felt("moveType")),
    moveName: decodeShortString(reader.felt("moveName")),
    tags: reader.u256("tags"),
    intent: reader.number("intent"),
    effectVector: reader.number("effectVector"),
    targetZone: reader.number("targetZone"),
    power: reader.number("power"),
    speed: reader.number("speed"),
    control: reader.number("control"),
    risk: reader.number("risk"),
    complexity: reader.number("complexity"),
    versatility: reader.number("versatility"),
    comboFlags: reader.number("comboFlags"),
    linkableToTags: reader.u256("linkableToTags"),
    requiresTagsBefore: reader.u256("requiresTagsBefore"),
    rarity: reader.number("rarity"),
    relicType: decodeShortString(reader.felt("relicType")),
    style: decodeShortString(reader.felt("style")),
    weightClass: decodeShortString(reader.felt("weightClass")),
  };
}

export function decodeRelicMetadataRpc(values: readonly string[]): RelicMetadata {
  const reader = new CairoReader(values, "RelicMetadata");
  const metadata = readRelicMetadata(reader);
  reader.done();
  return metadata;
}

export function decodeRelicDataRpc(values: readonly string[]): { definitionId: bigint; editionNumber: bigint; metadata: RelicMetadata } {
  const reader = new CairoReader(values, "RelicData");
  const data = {
    definitionId: reader.u256("definitionId"),
    editionNumber: reader.u256("editionNumber"),
    metadata: readRelicMetadata(reader),
  };
  reader.done();
  return data;
}

export function decodeByteArrayRpc(values: readonly string[], context = "ByteArray"): string {
  const reader = new CairoReader(values, context);
  const value = reader.byteArray(context);
  reader.done();
  return value;
}

function readRelicRow(reader: CairoReader): Relic {
  const tokenId = reader.u256("tokenId");
  const owner = reader.address("owner");
  const definitionId = reader.u256("definitionId");
  const editionNumber = reader.u256("editionNumber");
  const metadata = readRelicMetadata(reader);
  const eventName = reader.byteArray("eventName");
  const tokenUri = reader.byteArray("tokenUri");
  return {
    tokenId,
    owner,
    definitionId,
    editionNumber,
    metadata,
    eventName,
    tokenUri,
    attributes: [],
    metadataSources: ["starknet-rpc"],
  };
}

export function decodeRelicRowsRpc(values: readonly string[]): Relic[] {
  const reader = new CairoReader(values, "RelicFeedRow[]");
  const count = reader.number("length");
  const relics = Array.from({ length: count }, () => readRelicRow(reader));
  reader.done();
  return relics;
}

export function decodeOwnedRelicPageRpc(values: readonly string[]): { items: Relic[]; cursor: bigint } {
  const reader = new CairoReader(values, "RelicPage");
  const count = reader.number("rows.length");
  const items = Array.from({ length: count }, () => readRelicRow(reader));
  const cursor = reader.u256("nextCursor");
  reader.done();
  return { items, cursor };
}

export function decodeSingleU256(values: readonly string[], context = "u256"): bigint {
  const reader = new CairoReader(values, context);
  const value = reader.u256(context);
  reader.done();
  return value;
}

export function decodeSingleBool(values: readonly string[], context = "bool"): boolean {
  const reader = new CairoReader(values, context);
  const value = reader.bool(context);
  reader.done();
  return value;
}

export function decodeSingleNumber(values: readonly string[], context = "number"): number {
  const reader = new CairoReader(values, context);
  const value = reader.number(context);
  reader.done();
  return value;
}
