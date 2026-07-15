import { normalizeAddress } from "./codecs.js";
import type { RelicFeedInput } from "./relics.js";
import type { Address, CageCallsQueryKey } from "./types.js";

const key = (scope: string, ...values: readonly unknown[]): CageCallsQueryKey => ["cage-calls", scope, ...values];

export const cageCallsQueryKeys = Object.freeze({
  all: () => key("all"),
  fighters: (input?: { active?: boolean; limit?: number; cursor?: string }) => key("fighters", ...(input ? [input.active ?? "all", input.limit ?? "default", input.cursor ?? "start"] : [])),
  fightersMany: (fighterIds: readonly bigint[]) => key("fighters", "many", ...fighterIds.map(String)),
  fighter: (fighterId: bigint) => key("fighter", fighterId.toString()),
  fights: (input?: { limit?: number; cursor?: string; seasonId?: bigint }) => key("fights", ...(input ? [input.limit ?? "default", input.cursor ?? "start", input.seasonId?.toString() ?? "all"] : [])),
  fight: (fightId: bigint) => key("fight", fightId.toString()),
  fightFeed: (input?: { limit?: number; cursor?: bigint; viewer?: Address }) => key("fight-feed", input?.limit ?? "default", input?.cursor?.toString() ?? "start", input?.viewer ? normalizeAddress(input.viewer) : "none"),
  fightBuys: (fightId: bigint, input?: { offset?: number; limit?: number }) => key("fight-buys", fightId.toString(), input?.offset ?? 0, input?.limit ?? "default"),
  fightEvents: (input?: { limit?: number; cursor?: bigint; viewer?: Address; now?: bigint }) => key("fight-events", input?.limit ?? "default", input?.cursor?.toString() ?? "start", input?.viewer ? normalizeAddress(input.viewer) : "none", input?.now?.toString() ?? "clock"),
  portfolio: (account: Address, input?: { limit?: number; cursor?: string }) => key("portfolio", normalizeAddress(account), input?.limit ?? "default", input?.cursor ?? "start"),
  markets: (input?: { limit?: number; cursor?: string }) => key("markets", input?.limit ?? "default", input?.cursor ?? "start"),
  market: (marketId: bigint) => key("market", marketId.toString()),
  relics: (input?: RelicFeedInput) => key("relics", input?.limit ?? "default", input?.cursor?.toString() ?? "start", input?.metadata ?? "external"),
  relicsMany: (tokenIds: readonly bigint[]) => key("relics", "many", ...tokenIds.map(String)),
  relic: (tokenId: bigint) => key("relic", tokenId.toString()),
  ownedRelics: (account: Address) => key("owned-relics", normalizeAddress(account)),
  gacha: (fightId: bigint) => key("gacha", fightId.toString()),
  gachaUser: (fightId: bigint, account: Address) => key("gacha-user", fightId.toString(), normalizeAddress(account)),
  gachaTokens: (fightId: bigint, input?: { cursor?: bigint; limit?: number }) => key("gacha", fightId.toString(), "tokens", input?.cursor?.toString() ?? "start", input?.limit ?? "default"),
  tokens: (account?: Address, detail = "all") => key("tokens", account ? normalizeAddress(account) : "all", detail),
  activity: (input?: { limit?: number; cursor?: string; keys?: string[] }) => key("activity", input?.limit ?? "default", input?.cursor ?? "start", ...(input?.keys ?? [])),
  admin: (detail = "all") => key("admin", detail),
});
