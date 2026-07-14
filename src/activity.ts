import { createDataResult } from "./core.js";
import { normalizeAddress, normalizeFelt, selectorFromName } from "./codecs.js";
import { AllSourcesFailedError, UnsupportedCapabilityError } from "./errors.js";
import type { RepositoryContext } from "./repositories.js";
import { transportAttemptsFromError } from "./transports.js";
import type {
  CageCallsActivity,
  DataResult,
  Page,
  RawCageCallsEvent,
  RequestOptions,
} from "./types.js";

const EVENT_TYPES = new Map<string, { name: string; type: CageCallsActivity["type"]; action?: "preparation" | "resolution" | "split" | "merge" | "redemption" }>([
  [selectorFromName("FightCreated"), { name: "FightCreated", type: "fight-created" }],
  [selectorFromName("MarketCreated"), { name: "MarketCreated", type: "market-lifecycle" }],
  [selectorFromName("MarketBuy"), { name: "MarketBuy", type: "market-buy" }],
  [selectorFromName("PayoutRedemption"), { name: "PayoutRedemption", type: "payout-redemption" }],
  [selectorFromName("Struck"), { name: "Struck", type: "gacha-strike" }],
  [selectorFromName("Kept"), { name: "Kept", type: "gacha-keep" }],
  [selectorFromName("Transfer"), { name: "Transfer", type: "relic-transfer" }],
  [selectorFromName("MetadataUpdate"), { name: "MetadataUpdate", type: "relic-metadata-update" }],
  [selectorFromName("FighterRegistered"), { name: "FighterRegistered", type: "fighter-registration" }],
  [selectorFromName("FighterUpdated"), { name: "FighterUpdated", type: "fighter-update" }],
  [selectorFromName("FighterActivated"), { name: "FighterActivated", type: "fighter-activation" }],
  [selectorFromName("FighterDeactivated"), { name: "FighterDeactivated", type: "fighter-activation" }],
  [selectorFromName("ConditionPreparation"), { name: "ConditionPreparation", type: "conditional-token", action: "preparation" }],
  [selectorFromName("ConditionResolution"), { name: "ConditionResolution", type: "conditional-token", action: "resolution" }],
  [selectorFromName("PositionSplit"), { name: "PositionSplit", type: "conditional-token", action: "split" }],
  [selectorFromName("PositionsMerge"), { name: "PositionsMerge", type: "conditional-token", action: "merge" }],
]);

function parseTimestamp(value?: string): bigint | undefined {
  if (!value) return undefined;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? BigInt(Math.floor(milliseconds / 1_000)) : undefined;
}

export function decodeActivity(network: string, event: RawCageCallsEvent): CageCallsActivity {
  const selector = event.selector ?? event.keys[0];
  const definition = selector ? EVENT_TYPES.get(normalizeFelt(selector)) : undefined;
  const base = {
    network,
    contract: event.contract,
    ...(event.transactionHash ? { transactionHash: event.transactionHash } : {}),
    ...(event.blockNumber === undefined ? {} : { blockNumber: event.blockNumber }),
    ...(event.timestamp === undefined ? {} : { timestamp: event.timestamp }),
    raw: event,
  };
  const payload: Record<string, unknown> = { keys: event.keys.slice(1), data: event.data };
  switch (definition?.type) {
    case "fight-created": return { ...base, type: "fight-created", payload };
    case "market-buy": return { ...base, type: "market-buy", payload };
    case "market-lifecycle": return { ...base, type: "market-lifecycle", payload };
    case "payout-redemption": return { ...base, type: "payout-redemption", payload };
    case "gacha-strike": return { ...base, type: "gacha-strike", payload };
    case "gacha-keep": return { ...base, type: "gacha-keep", payload };
    case "relic-transfer": return { ...base, type: "relic-transfer", payload };
    case "relic-metadata-update": return { ...base, type: "relic-metadata-update", payload };
    case "fighter-registration": return { ...base, type: "fighter-registration", payload };
    case "fighter-update": return { ...base, type: "fighter-update", payload };
    case "fighter-activation": return { ...base, type: "fighter-activation", payload };
    case "conditional-token": return { ...base, type: "conditional-token", action: definition.action ?? "resolution", payload };
    default: return { ...base, type: "unknown", payload };
  }
}

export interface ActivityRepository {
  list(input?: { limit?: number; cursor?: string; keys?: string[] }, options?: RequestOptions): Promise<DataResult<Page<CageCallsActivity>>>;
  raw(input?: { limit?: number; cursor?: string; keys?: string[] }, options?: RequestOptions): Promise<DataResult<Page<RawCageCallsEvent>>>;
}

export function createActivityRepository(context: RepositoryContext): ActivityRepository {
  const raw = async (input: { limit?: number; cursor?: string; keys?: string[] } = {}, options: RequestOptions = {}) => {
    const startedAt = context.now();
    if (!context.torii) throw new UnsupportedCapabilityError("activity enumeration without Torii");
    try {
      const response = await context.torii.events({
        first: Math.min(Math.max(input.limit ?? 50, 1), context.budget.pageSize),
        ...(input.cursor ? { after: input.cursor } : {}),
        ...(input.keys ? { keys: input.keys } : {}),
      }, options);
      const items = response.data.edges.map(({ node }) => {
        const event: RawCageCallsEvent = {
          ...(node.keys[0] ? { selector: normalizeFelt(node.keys[0]) } : {}),
          contract: context.network.worldAddress,
          keys: node.keys.map((value) => normalizeFelt(value)),
          data: node.data.map((value) => normalizeFelt(value)),
          raw: node,
        };
        if (node.transactionHash) event.transactionHash = normalizeFelt(node.transactionHash);
        const timestamp = parseTimestamp(node.executedAt ?? node.createdAt);
        if (timestamp !== undefined) event.timestamp = timestamp;
        return event;
      });
      return createDataResult({
        data: {
          items,
          ...(response.data.pageInfo.endCursor ? { cursor: response.data.pageInfo.endCursor } : {}),
          hasMore: response.data.pageInfo.hasNextPage,
        },
        source: "torii",
        complete: true,
        attempts: response.attempts,
        warnings: [{
          code: "EVENT_CONTRACT_INFERENCE",
          message: "Torii generic events do not expose the emitting contract; registered Dojo events use the world address and retain raw keys.",
          source: "torii",
        }],
        startedAt,
        now: context.now,
        ...(context.logger ? { logger: context.logger } : {}),
      });
    } catch (error) {
      throw new AllSourcesFailedError("activity.raw", transportAttemptsFromError(error));
    }
  };

  return {
    raw,
    async list(input = {}, options = {}) {
      const startedAt = context.now();
      const response = await raw(input, options);
      return createDataResult({
        data: {
          items: response.data.items.map((event) => decodeActivity(context.network.name, event)),
          ...(response.data.cursor ? { cursor: response.data.cursor } : {}),
          hasMore: response.data.hasMore,
        },
        source: "derived",
        complete: response.meta.complete,
        attempts: response.meta.attempts,
        warnings: response.meta.warnings,
        startedAt,
        now: context.now,
        ...(context.logger ? { logger: context.logger } : {}),
      });
    },
  };
}
