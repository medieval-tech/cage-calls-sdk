import type { DataWarning, Fighter, Relic } from "./types.js";

export const RELIC_STAT_NAMES = [
  "power",
  "speed",
  "control",
  "risk",
  "complexity",
  "versatility",
] as const;

export type RelicStatName = typeof RELIC_STAT_NAMES[number];
export type RelicRarityTier = "common" | "rare" | "mythic" | "shiny";

export interface RelicStatsFilter {
  fighterKeys?: readonly string[];
  /** @deprecated Prefer fighterKeys; retained for exact onchain metadata callers. */
  fighterIds?: readonly bigint[];
  seasonIds?: readonly bigint[];
  fightIds?: readonly bigint[];
  rarityTiers?: readonly RelicRarityTier[];
  rarityLevels?: readonly number[];
  moveTypes?: readonly string[];
}

export interface RelicStatAverages {
  power: number;
  speed: number;
  control: number;
  risk: number;
  complexity: number;
  versatility: number;
}

export interface RelicStatsBreakdown<Key extends string | number | bigint = string> {
  key: Key;
  label: string;
  count: number;
  percentage: number;
  averages: RelicStatAverages;
  fighter?: Fighter;
}

export interface RelicStatsView {
  count: number;
  averages: RelicStatAverages;
  byFighter: RelicStatsBreakdown<string>[];
  byMoveType: RelicStatsBreakdown<string>[];
  byRarityTier: RelicStatsBreakdown<RelicRarityTier>[];
  byRarityLevel: RelicStatsBreakdown<number>[];
  bySeason: RelicStatsBreakdown<bigint>[];
  byFight: RelicStatsBreakdown<bigint>[];
}

export interface RelicStatsFacets {
  fighters: Array<{ fighterKey: string; label: string; fighterId?: bigint; fighter?: Fighter }>;
  moveTypes: Array<{ moveType: string; label: string }>;
  rarityTiers: RelicRarityTier[];
  rarityLevels: number[];
  seasonIds: bigint[];
  fightIds: bigint[];
}

export interface RelicCollectionStats {
  filter: RelicStatsFilter;
  coverage: {
    inventoryCount: number;
    metadataCount: number;
    indexedMetadataCount: number;
    rpcHydratedCount: number;
    selectedCount: number;
    missingMetadata: number;
    missingDefinitionIds: number;
  };
  facets: RelicStatsFacets;
  minted: RelicStatsView;
  definitions: RelicStatsView;
  warnings: DataWarning[];
}

interface StatsRelic {
  relic: Relic;
  definitionKey?: string;
  definitionSignature: string;
  fighterKey: string;
  fighterLabel: string;
  fighterId?: bigint;
  fighter?: Fighter;
  seasonId: bigint;
  fightId: bigint;
  rarity: number;
  moveType: string;
  moveName: string;
  averages: RelicStatAverages;
}

const EMPTY_AVERAGES: RelicStatAverages = {
  power: 0,
  speed: 0,
  control: 0,
  risk: 0,
  complexity: 0,
  versatility: 0,
};

const RARITY_BY_LABEL = new Map([
  ["common_1", 0],
  ["common_2", 1],
  ["common_3", 2],
  ["rare_1", 3],
  ["rare_2", 4],
  ["mythic", 5],
  ["shiny_mythic", 6],
]);

export function relicRarityTier(rarity: number): RelicRarityTier {
  if (rarity <= 2) return "common";
  if (rarity <= 4) return "rare";
  if (rarity === 5) return "mythic";
  return "shiny";
}

export function relicRarityLabel(rarity: number): string {
  return ["Common 1", "Common 2", "Common 3", "Rare 1", "Rare 2", "Mythic", "Shiny Mythic"][rarity]
    ?? `Rarity ${rarity}`;
}

export function normalizeRelicMoveType(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "unknown";
}

export function relicMoveTypeLabel(value: string): string {
  return normalizeRelicMoveType(value)
    .split("_")
    .map((part) => part ? `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}` : "")
    .join(" ");
}

function normalizeFighterKey(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "unknown";
}

function uniqueBigInts(values: readonly bigint[] | undefined): bigint[] | undefined {
  return values ? Array.from(new Set(values.map(String))).map(BigInt).sort((a, b) => a < b ? -1 : a > b ? 1 : 0) : undefined;
}

function normalizeFilter(filter: RelicStatsFilter): RelicStatsFilter {
  const fighterKeys = filter.fighterKeys
    ? Array.from(new Set(filter.fighterKeys.map(normalizeFighterKey))).sort()
    : undefined;
  const fighterIds = uniqueBigInts(filter.fighterIds);
  const seasonIds = uniqueBigInts(filter.seasonIds);
  const fightIds = uniqueBigInts(filter.fightIds);
  const rarityTiers = filter.rarityTiers ? Array.from(new Set(filter.rarityTiers)).sort() : undefined;
  const rarityLevels = filter.rarityLevels ? Array.from(new Set(filter.rarityLevels)).sort((a, b) => a - b) : undefined;
  const moveTypes = filter.moveTypes ? Array.from(new Set(filter.moveTypes.map(normalizeRelicMoveType))).sort() : undefined;
  return {
    ...(fighterKeys?.length ? { fighterKeys } : {}),
    ...(fighterIds?.length ? { fighterIds } : {}),
    ...(seasonIds?.length ? { seasonIds } : {}),
    ...(fightIds?.length ? { fightIds } : {}),
    ...(rarityTiers?.length ? { rarityTiers } : {}),
    ...(rarityLevels?.length ? { rarityLevels } : {}),
    ...(moveTypes?.length ? { moveTypes } : {}),
  };
}

function traitKey(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function attributes(relic: Relic): Map<string, string | number | boolean | null> {
  const values = new Map<string, string | number | boolean | null>();
  for (const attribute of relic.attributes) {
    if (!attribute.traitType || attribute.value === undefined || values.has(traitKey(attribute.traitType))) continue;
    values.set(traitKey(attribute.traitType), attribute.value);
  }
  return values;
}

function attributeValue(
  values: ReadonlyMap<string, string | number | boolean | null>,
  ...keys: string[]
): string | number | boolean | null | undefined {
  for (const key of keys) {
    const value = values.get(key);
    if (value !== undefined && value !== null && String(value).trim()) return value;
  }
  return undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : value === undefined || value === null ? undefined : String(value);
}

function numberValue(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value.trim()) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
}

function bigintValue(value: unknown): bigint | undefined {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isSafeInteger(value)) return BigInt(value);
  if (typeof value !== "string") return undefined;
  const direct = value.trim();
  try { return BigInt(direct); } catch { /* try the first decimal component below */ }
  const match = direct.match(/(?:^|\s|#)(\d+)(?:$|\s)/);
  return match?.[1] ? BigInt(match[1]) : undefined;
}

function rarityValue(value: unknown): number | undefined {
  const numeric = numberValue(value);
  if (numeric !== undefined && Number.isInteger(numeric) && numeric >= 0 && numeric <= 6) return numeric;
  const label = stringValue(value);
  return label ? RARITY_BY_LABEL.get(normalizeRelicMoveType(label)) : undefined;
}

function resolveFighterByName(name: string, fighters: readonly Fighter[]): Fighter | undefined {
  const key = normalizeFighterKey(name);
  return fighters.find((fighter) => normalizeFighterKey(fighter.name) === key);
}

function exactStatsRelic(relic: Relic, fighters: readonly Fighter[]): StatsRelic | undefined {
  const metadata = relic.metadata;
  if (!metadata) return undefined;
  const fighter = fighters.find((value) => value.fighterId === metadata.fighterId);
  const fighterLabel = fighter?.name ?? `Fighter #${metadata.fighterId}`;
  const fighterKey = fighter ? normalizeFighterKey(fighter.name) : `id_${metadata.fighterId}`;
  const averages = Object.fromEntries(RELIC_STAT_NAMES.map((name) => [name, metadata[name]])) as unknown as RelicStatAverages;
  const definitionSignature = [
    metadata.seasonId, metadata.fightId, fighterKey, metadata.opponentId, metadata.rarity,
    normalizeRelicMoveType(metadata.moveType), metadata.moveName, ...RELIC_STAT_NAMES.map((name) => metadata[name]),
  ].join("|");
  const definitionId = relic.definitionId ?? metadata.definitionId;
  return {
    relic,
    ...(definitionId > 0n ? { definitionKey: `id:${definitionId}` } : { definitionKey: `inferred:${definitionSignature}` }),
    definitionSignature,
    fighterKey,
    fighterLabel,
    fighterId: metadata.fighterId,
    ...(fighter ? { fighter } : {}),
    seasonId: metadata.seasonId,
    fightId: metadata.fightId,
    rarity: metadata.rarity,
    moveType: normalizeRelicMoveType(metadata.moveType),
    moveName: metadata.moveName,
    averages,
  };
}

function indexedStatsRelic(relic: Relic, fighters: readonly Fighter[]): StatsRelic | undefined {
  const values = attributes(relic);
  const fighterLabel = stringValue(attributeValue(values, "fighter", "fighter_name"));
  const seasonId = bigintValue(attributeValue(values, "season", "season_id"));
  const fightId = bigintValue(attributeValue(values, "fight", "fight_id"));
  const rarity = rarityValue(attributeValue(values, "rarity", "rarity_level"));
  const moveTypeValue = stringValue(attributeValue(values, "move_type", "category"));
  const moveName = stringValue(attributeValue(values, "move_name", "move")) ?? relic.name ?? "Unknown move";
  const statValues = Object.fromEntries(RELIC_STAT_NAMES.map((name) => [name, numberValue(attributeValue(values, name))])) as Record<RelicStatName, number | undefined>;
  if (!fighterLabel || seasonId === undefined || fightId === undefined || rarity === undefined || !moveTypeValue
    || RELIC_STAT_NAMES.some((name) => statValues[name] === undefined)) return undefined;

  const fighter = resolveFighterByName(fighterLabel, fighters);
  const fighterKey = normalizeFighterKey(fighter?.name ?? fighterLabel);
  const opponent = stringValue(attributeValue(values, "opponent", "opponent_name")) ?? "unknown";
  const averages = Object.fromEntries(RELIC_STAT_NAMES.map((name) => [name, statValues[name] as number])) as unknown as RelicStatAverages;
  const definitionId = bigintValue(attributeValue(values, "definition_id", "relic_definition_id"));
  const definitionSignature = [
    seasonId, fightId, fighterKey, normalizeFighterKey(opponent), rarity,
    normalizeRelicMoveType(moveTypeValue), moveName, ...RELIC_STAT_NAMES.map((name) => averages[name]),
  ].join("|");
  return {
    relic,
    definitionKey: definitionId && definitionId > 0n ? `id:${definitionId}` : `inferred:${definitionSignature}`,
    definitionSignature,
    fighterKey,
    fighterLabel: fighter?.name ?? fighterLabel,
    ...(fighter ? { fighter, fighterId: fighter.fighterId } : {}),
    seasonId,
    fightId,
    rarity,
    moveType: normalizeRelicMoveType(moveTypeValue),
    moveName,
    averages,
  };
}

function statsRelic(relic: Relic, fighters: readonly Fighter[]): StatsRelic | undefined {
  return exactStatsRelic(relic, fighters) ?? indexedStatsRelic(relic, fighters);
}

function matchesFilter(value: StatsRelic, filter: RelicStatsFilter): boolean {
  if (filter.fighterKeys && !filter.fighterKeys.includes(value.fighterKey)) return false;
  if (filter.fighterIds && (!value.fighterId || !filter.fighterIds.includes(value.fighterId))) return false;
  if (filter.seasonIds && !filter.seasonIds.includes(value.seasonId)) return false;
  if (filter.fightIds && !filter.fightIds.includes(value.fightId)) return false;
  if (filter.rarityTiers && !filter.rarityTiers.includes(relicRarityTier(value.rarity))) return false;
  if (filter.rarityLevels && !filter.rarityLevels.includes(value.rarity)) return false;
  if (filter.moveTypes && !filter.moveTypes.includes(value.moveType)) return false;
  return true;
}

export function filterRelicCollection(
  relics: readonly Relic[],
  filter: RelicStatsFilter = {},
  fighters: readonly Fighter[] = [],
): Relic[] {
  const normalizedFilter = normalizeFilter(filter);
  return relics.filter((relic) => {
    const value = statsRelic(relic, fighters);
    return value ? matchesFilter(value, normalizedFilter) : false;
  });
}

export function relicDefinitionKey(relic: Relic, fighters: readonly Fighter[] = []): string {
  return statsRelic(relic, fighters)?.definitionKey ?? `token:${relic.tokenId}`;
}

function averages(relics: readonly StatsRelic[]): RelicStatAverages {
  if (relics.length === 0) return { ...EMPTY_AVERAGES };
  const totals = { ...EMPTY_AVERAGES };
  for (const relic of relics) {
    for (const name of RELIC_STAT_NAMES) totals[name] += relic.averages[name];
  }
  for (const name of RELIC_STAT_NAMES) totals[name] /= relics.length;
  return totals;
}

function group<Key extends string | number | bigint>(
  relics: readonly StatsRelic[],
  keyOf: (relic: StatsRelic) => Key,
  labelOf: (key: Key, relic: StatsRelic) => string,
): RelicStatsBreakdown<Key>[] {
  const groups = new Map<string, { key: Key; relics: StatsRelic[] }>();
  for (const relic of relics) {
    const key = keyOf(relic);
    const mapKey = String(key);
    const entry = groups.get(mapKey) ?? { key, relics: [] };
    entry.relics.push(relic);
    groups.set(mapKey, entry);
  }
  return Array.from(groups.values()).map(({ key, relics: values }) => {
    const representative = values[0] as StatsRelic;
    return {
      key,
      label: labelOf(key, representative),
      count: values.length,
      percentage: relics.length ? (values.length / relics.length) * 100 : 0,
      averages: averages(values),
      ...(representative.fighter ? { fighter: representative.fighter } : {}),
    };
  }).sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

function view(relics: readonly StatsRelic[]): RelicStatsView {
  return {
    count: relics.length,
    averages: averages(relics),
    byFighter: group(relics, (relic) => relic.fighterKey, (_key, relic) => relic.fighterLabel),
    byMoveType: group(relics, (relic) => relic.moveType, (key) => relicMoveTypeLabel(key)),
    byRarityTier: group(relics, (relic) => relicRarityTier(relic.rarity), (key) => `${key[0]?.toUpperCase() ?? ""}${key.slice(1)}`),
    byRarityLevel: group(relics, (relic) => relic.rarity, (key) => relicRarityLabel(key)),
    bySeason: group(relics, (relic) => relic.seasonId, (key) => `Season ${key}`),
    byFight: group(relics, (relic) => relic.fightId, (key) => `Fight #${key}`),
  };
}

function facets(relics: readonly StatsRelic[]): RelicStatsFacets {
  const fighters = new Map<string, StatsRelic>();
  for (const relic of relics) if (!fighters.has(relic.fighterKey)) fighters.set(relic.fighterKey, relic);
  const moveTypes = Array.from(new Set(relics.map((relic) => relic.moveType)));
  return {
    fighters: Array.from(fighters.values()).map((relic) => ({
      fighterKey: relic.fighterKey,
      label: relic.fighterLabel,
      ...(relic.fighterId === undefined ? {} : { fighterId: relic.fighterId }),
      ...(relic.fighter ? { fighter: relic.fighter } : {}),
    })).sort((a, b) => a.label.localeCompare(b.label)),
    moveTypes: moveTypes.map((moveType) => ({ moveType, label: relicMoveTypeLabel(moveType) })).sort((a, b) => a.label.localeCompare(b.label)),
    rarityTiers: Array.from(new Set(relics.map((relic) => relicRarityTier(relic.rarity)))).sort(),
    rarityLevels: Array.from(new Set(relics.map((relic) => relic.rarity))).sort((a, b) => a - b),
    seasonIds: Array.from(new Set(relics.map((relic) => relic.seasonId.toString()))).map(BigInt).sort((a, b) => a < b ? -1 : a > b ? 1 : 0),
    fightIds: Array.from(new Set(relics.map((relic) => relic.fightId.toString()))).map(BigInt).sort((a, b) => a < b ? -1 : a > b ? 1 : 0),
  };
}

export function summarizeRelicCollection(
  relics: readonly Relic[],
  filter: RelicStatsFilter = {},
  fighters: readonly Fighter[] = [],
): RelicCollectionStats {
  const normalizedFilter = normalizeFilter(filter);
  const withMetadata = relics.flatMap((relic) => {
    const value = statsRelic(relic, fighters);
    return value ? [value] : [];
  });
  const selected = withMetadata.filter((relic) => matchesFilter(relic, normalizedFilter));
  const definitions = new Map<string, StatsRelic>();
  const warnings: DataWarning[] = [];
  let missingDefinitionIds = 0;

  for (const relic of selected) {
    if (!relic.definitionKey) {
      missingDefinitionIds += 1;
      continue;
    }
    const existing = definitions.get(relic.definitionKey);
    if (!existing || relic.relic.tokenId < existing.relic.tokenId) definitions.set(relic.definitionKey, relic);
    if (existing && relic.definitionKey.startsWith("id:") && existing.definitionSignature !== relic.definitionSignature) {
      warnings.push({
        code: "RELIC_DEFINITION_METADATA_CONFLICT",
        message: `Relic definition ${relic.definitionKey.slice(3)} has inconsistent token metadata; the lowest token ID was used.`,
        source: "derived",
      });
    }
  }

  return {
    filter: normalizedFilter,
    coverage: {
      inventoryCount: relics.length,
      metadataCount: withMetadata.length,
      indexedMetadataCount: withMetadata.filter((value) => value.relic.metadataSources?.includes("torii") && !value.relic.metadataSources.includes("starknet-rpc")).length,
      rpcHydratedCount: withMetadata.filter((value) => value.relic.metadataSources?.includes("starknet-rpc")).length,
      selectedCount: selected.length,
      missingMetadata: relics.length - withMetadata.length,
      missingDefinitionIds,
    },
    facets: facets(withMetadata),
    minted: view(selected),
    definitions: view(Array.from(definitions.values())),
    warnings,
  };
}
