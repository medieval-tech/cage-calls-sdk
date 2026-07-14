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
  // Dojo resource selectors from the pinned `pm` manifests. Registered events
  // are wrapped by EventEmitted and use these selectors as their second key.
  ["0x644e1bb97b57df49a85972b4c2cbf1788385071f02f85afce24e573512909ab", { name: "FightCreated", type: "fight-created" }],
  ["0x59cd6e838e5a04ad17b8dca262ade7c17dcfdbc78044b478d6a70f46ffbd5a4", { name: "MarketCreated", type: "market-lifecycle" }],
  ["0x4cdcbcd64b50bc7598b8fe9bf10edde9aa262dc8170630c67d4dbbcb4122c57", { name: "MarketBuy", type: "market-buy" }],
  ["0x7efeccfe4aa8429dbb06301e9cf86ec73eb12af2f2396431e7d97465ba5f6bf", { name: "PayoutRedemption", type: "payout-redemption" }],
  ["0x1b420058b6f6722043e1dc5d490fefa894ccd9ddd21dea09363300d55ccbf7c", { name: "FighterRegistered", type: "fighter-registration" }],
  ["0x21be506d0fef670626b1e0ad9bfba41dcc9de1c07796e457ca2d3b805b22c82", { name: "FighterUpdated", type: "fighter-update" }],
  ["0x654accbd51b3c7b7aad0a69efb22759bd73baea52472335a10329afaf7df1b0", { name: "FighterActivated", type: "fighter-activation" }],
  ["0x42e9c702491f1c8d4859d3f7721e33d2d7b077c4e068dbb3c2c854c5f8d075d", { name: "FighterDeactivated", type: "fighter-activation" }],
  ["0x7af67d3e52eac00b3370db7ffd64e03029873cb2e08ac7bf4b75f9812e9a470", { name: "ConditionPreparation", type: "conditional-token", action: "preparation" }],
  ["0x49bf93e98a06453ffc513d92d4a31e367226d96bd4c76f9ef72f0e2f1e8937e", { name: "ConditionResolution", type: "conditional-token", action: "resolution" }],
  ["0x19c206ec72a0716df29ab279b998e7abb63b46ef4fa8a685eae62ab7c6c7a9c", { name: "PositionSplit", type: "conditional-token", action: "split" }],
  ["0x43df21642b961fb90fbd9623c068a1cc5a57b202591b1588fed885fdeb80d4b", { name: "PositionsMerge", type: "conditional-token", action: "merge" }],
]);

const DOJO_EVENT_EMITTED = selectorFromName("EventEmitted");

function parseTimestamp(value?: string): bigint | undefined {
  if (!value) return undefined;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? BigInt(Math.floor(milliseconds / 1_000)) : undefined;
}

export function decodeActivity(network: string, event: RawCageCallsEvent): CageCallsActivity {
  const dojoResourceSelector = event.keys[0] === DOJO_EVENT_EMITTED ? event.keys[1] : undefined;
  const selector = dojoResourceSelector ?? event.selector ?? event.keys[0];
  const definition = selector ? EVENT_TYPES.get(normalizeFelt(selector)) : undefined;
  const base = {
    network,
    contract: event.contract,
    ...(event.transactionHash ? { transactionHash: event.transactionHash } : {}),
    ...(event.blockNumber === undefined ? {} : { blockNumber: event.blockNumber }),
    ...(event.timestamp === undefined ? {} : { timestamp: event.timestamp }),
    raw: event,
  };
  const payload: Record<string, unknown> = {
    keys: event.keys.slice(dojoResourceSelector ? 2 : 1),
    data: event.data,
    ...(definition ? { eventName: definition.name } : {}),
  };
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
      let inferredContract = false;
      const items = response.data.edges.map(({ node }) => {
        const idParts = node.id.split(":");
        let contract = context.network.worldAddress;
        let blockNumber: bigint | undefined;
        try {
          if (idParts[2]) contract = normalizeAddress(idParts[2]);
          else inferredContract = true;
        } catch {
          inferredContract = true;
        }
        try {
          if (idParts[0]) blockNumber = BigInt(idParts[0]);
        } catch {
          // Older Torii event IDs may not include the block number.
        }
        const event: RawCageCallsEvent = {
          ...(node.keys[0] ? { selector: normalizeFelt(node.keys[0]) } : {}),
          contract,
          ...(blockNumber === undefined ? {} : { blockNumber }),
          keys: node.keys.map((value) => normalizeFelt(value)),
          data: node.data.map((value) => normalizeFelt(value)),
          raw: node,
        };
        const transactionHash = node.transactionHash ?? idParts[1];
        if (transactionHash) event.transactionHash = normalizeFelt(transactionHash);
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
        warnings: inferredContract ? [{
          code: "EVENT_CONTRACT_INFERENCE",
          message: "A legacy Torii event ID omitted its emitting contract; the world address was used and raw keys were retained.",
          source: "torii",
        }] : [],
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
