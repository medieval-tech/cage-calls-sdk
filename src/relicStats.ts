import type { DataWarning, Fighter, Relic, RelicMetadata } from "./types.js";

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
  byFighter: RelicStatsBreakdown<bigint>[];
  byMoveType: RelicStatsBreakdown<string>[];
  byRarityTier: RelicStatsBreakdown<RelicRarityTier>[];
  byRarityLevel: RelicStatsBreakdown<number>[];
  bySeason: RelicStatsBreakdown<bigint>[];
  byFight: RelicStatsBreakdown<bigint>[];
}

export interface RelicStatsFacets {
  fighters: Array<{ fighterId: bigint; label: string; fighter?: Fighter }>;
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
    selectedCount: number;
    missingMetadata: number;
    missingDefinitionIds: number;
  };
  facets: RelicStatsFacets;
  minted: RelicStatsView;
  definitions: RelicStatsView;
  warnings: DataWarning[];
}

type MetadataRelic = Relic & { metadata: RelicMetadata };

const EMPTY_AVERAGES: RelicStatAverages = {
  power: 0,
  speed: 0,
  control: 0,
  risk: 0,
  complexity: 0,
  versatility: 0,
};

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

function uniqueBigInts(values: readonly bigint[] | undefined): bigint[] | undefined {
  return values ? Array.from(new Set(values.map(String))).map(BigInt).sort((a, b) => a < b ? -1 : a > b ? 1 : 0) : undefined;
}

function normalizeFilter(filter: RelicStatsFilter): RelicStatsFilter {
  const fighterIds = uniqueBigInts(filter.fighterIds);
  const seasonIds = uniqueBigInts(filter.seasonIds);
  const fightIds = uniqueBigInts(filter.fightIds);
  const rarityTiers = filter.rarityTiers ? Array.from(new Set(filter.rarityTiers)).sort() : undefined;
  const rarityLevels = filter.rarityLevels ? Array.from(new Set(filter.rarityLevels)).sort((a, b) => a - b) : undefined;
  const moveTypes = filter.moveTypes ? Array.from(new Set(filter.moveTypes.map(normalizeRelicMoveType))).sort() : undefined;
  return {
    ...(fighterIds?.length ? { fighterIds } : {}),
    ...(seasonIds?.length ? { seasonIds } : {}),
    ...(fightIds?.length ? { fightIds } : {}),
    ...(rarityTiers?.length ? { rarityTiers } : {}),
    ...(rarityLevels?.length ? { rarityLevels } : {}),
    ...(moveTypes?.length ? { moveTypes } : {}),
  };
}

function matchesFilter(relic: MetadataRelic, filter: RelicStatsFilter): boolean {
  const metadata = relic.metadata;
  if (filter.fighterIds && !filter.fighterIds.includes(metadata.fighterId)) return false;
  if (filter.seasonIds && !filter.seasonIds.includes(metadata.seasonId)) return false;
  if (filter.fightIds && !filter.fightIds.includes(metadata.fightId)) return false;
  if (filter.rarityTiers && !filter.rarityTiers.includes(relicRarityTier(metadata.rarity))) return false;
  if (filter.rarityLevels && !filter.rarityLevels.includes(metadata.rarity)) return false;
  if (filter.moveTypes && !filter.moveTypes.includes(normalizeRelicMoveType(metadata.moveType))) return false;
  return true;
}

/** Returns relics with on-chain metadata that match every selected filter dimension. */
export function filterRelicCollection(
  relics: readonly Relic[],
  filter: RelicStatsFilter = {},
): MetadataRelic[] {
  const normalizedFilter = normalizeFilter(filter);
  return relics
    .filter((relic): relic is MetadataRelic => Boolean(relic.metadata))
    .filter((relic) => matchesFilter(relic, normalizedFilter));
}

function averages(relics: readonly MetadataRelic[]): RelicStatAverages {
  if (relics.length === 0) return { ...EMPTY_AVERAGES };
  const totals = { ...EMPTY_AVERAGES };
  for (const relic of relics) {
    for (const name of RELIC_STAT_NAMES) totals[name] += relic.metadata[name];
  }
  for (const name of RELIC_STAT_NAMES) totals[name] /= relics.length;
  return totals;
}

function group<Key extends string | number | bigint>(
  relics: readonly MetadataRelic[],
  keyOf: (relic: MetadataRelic) => Key,
  labelOf: (key: Key) => string,
  fighterById?: ReadonlyMap<string, Fighter>,
): RelicStatsBreakdown<Key>[] {
  const groups = new Map<string, { key: Key; relics: MetadataRelic[] }>();
  for (const relic of relics) {
    const key = keyOf(relic);
    const mapKey = String(key);
    const entry = groups.get(mapKey) ?? { key, relics: [] };
    entry.relics.push(relic);
    groups.set(mapKey, entry);
  }
  return Array.from(groups.values()).map(({ key, relics: values }) => {
    const fighter = typeof key === "bigint" ? fighterById?.get(key.toString()) : undefined;
    return {
      key,
      label: labelOf(key),
      count: values.length,
      percentage: relics.length ? (values.length / relics.length) * 100 : 0,
      averages: averages(values),
      ...(fighter ? { fighter } : {}),
    };
  }).sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

function view(relics: readonly MetadataRelic[], fighterById: ReadonlyMap<string, Fighter>): RelicStatsView {
  return {
    count: relics.length,
    averages: averages(relics),
    byFighter: group(relics, (relic) => relic.metadata.fighterId, (key) => fighterById.get(key.toString())?.name || `Fighter #${key}`, fighterById),
    byMoveType: group(relics, (relic) => normalizeRelicMoveType(relic.metadata.moveType), relicMoveTypeLabel),
    byRarityTier: group(relics, (relic) => relicRarityTier(relic.metadata.rarity), (key) => `${key[0]?.toUpperCase() ?? ""}${key.slice(1)}`),
    byRarityLevel: group(relics, (relic) => relic.metadata.rarity, relicRarityLabel),
    bySeason: group(relics, (relic) => relic.metadata.seasonId, (key) => `Season ${key}`),
    byFight: group(relics, (relic) => relic.metadata.fightId, (key) => `Fight #${key}`),
  };
}

function facets(relics: readonly MetadataRelic[], fighterById: ReadonlyMap<string, Fighter>): RelicStatsFacets {
  const fighterIds = Array.from(new Set(relics.map((relic) => relic.metadata.fighterId.toString()))).map(BigInt);
  const moveTypes = Array.from(new Set(relics.map((relic) => normalizeRelicMoveType(relic.metadata.moveType))));
  return {
    fighters: fighterIds.map((fighterId) => {
      const fighter = fighterById.get(fighterId.toString());
      return { fighterId, label: fighter?.name || `Fighter #${fighterId}`, ...(fighter ? { fighter } : {}) };
    }).sort((a, b) => a.label.localeCompare(b.label)),
    moveTypes: moveTypes.map((moveType) => ({ moveType, label: relicMoveTypeLabel(moveType) })).sort((a, b) => a.label.localeCompare(b.label)),
    rarityTiers: Array.from(new Set(relics.map((relic) => relicRarityTier(relic.metadata.rarity)))).sort(),
    rarityLevels: Array.from(new Set(relics.map((relic) => relic.metadata.rarity))).sort((a, b) => a - b),
    seasonIds: Array.from(new Set(relics.map((relic) => relic.metadata.seasonId.toString()))).map(BigInt).sort((a, b) => a < b ? -1 : a > b ? 1 : 0),
    fightIds: Array.from(new Set(relics.map((relic) => relic.metadata.fightId.toString()))).map(BigInt).sort((a, b) => a < b ? -1 : a > b ? 1 : 0),
  };
}

function sameDefinitionMetadata(left: RelicMetadata, right: RelicMetadata): boolean {
  return left.fighterId === right.fighterId
    && left.fightId === right.fightId
    && left.rarity === right.rarity
    && normalizeRelicMoveType(left.moveType) === normalizeRelicMoveType(right.moveType)
    && RELIC_STAT_NAMES.every((name) => left[name] === right[name]);
}

export function summarizeRelicCollection(
  relics: readonly Relic[],
  filter: RelicStatsFilter = {},
  fighters: readonly Fighter[] = [],
): RelicCollectionStats {
  const normalizedFilter = normalizeFilter(filter);
  const fighterById = new Map(fighters.map((fighter) => [fighter.fighterId.toString(), fighter]));
  const withMetadata = relics.filter((relic): relic is MetadataRelic => Boolean(relic.metadata));
  const selected = filterRelicCollection(withMetadata, normalizedFilter);
  const definitions = new Map<string, MetadataRelic>();
  const warnings: DataWarning[] = [];
  let missingDefinitionIds = 0;

  for (const relic of selected) {
    const definitionId = relic.definitionId ?? relic.metadata.definitionId;
    if (definitionId <= 0n) {
      missingDefinitionIds += 1;
      continue;
    }
    const key = definitionId.toString();
    const existing = definitions.get(key);
    if (!existing || relic.tokenId < existing.tokenId) definitions.set(key, relic);
    if (existing && !sameDefinitionMetadata(existing.metadata, relic.metadata)) {
      warnings.push({
        code: "RELIC_DEFINITION_METADATA_CONFLICT",
        message: `Relic definition ${definitionId} has inconsistent token metadata; token ${relic.tokenId < existing.tokenId ? relic.tokenId : existing.tokenId} was used.`,
        source: "derived",
      });
    }
  }

  return {
    filter: normalizedFilter,
    coverage: {
      inventoryCount: relics.length,
      metadataCount: withMetadata.length,
      selectedCount: selected.length,
      missingMetadata: relics.length - withMetadata.length,
      missingDefinitionIds,
    },
    facets: facets(withMetadata, fighterById),
    minted: view(selected, fighterById),
    definitions: view(Array.from(definitions.values()), fighterById),
    warnings,
  };
}
