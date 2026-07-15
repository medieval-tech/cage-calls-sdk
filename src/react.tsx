import { createContext, createElement, useContext, useEffect, useRef, type ReactNode } from "react";
import { useQuery, useQueryClient, type UseQueryOptions } from "@tanstack/react-query";

import type { CageCallsClient } from "./client.js";
import type { AccountEventState, AccountPortfolio, EventRef, PublicEventSnapshot } from "./aggregates.js";
import type { AnalyticsSummaryFilter, CageCallsAnalyticsSummary } from "./analyticsSummary.js";
import { normalizeAddress } from "./codecs.js";
import { cageCallsQueryKeys as keys } from "./queryKeys.js";
import type { CageCallsLiveUpdate, LiveConnectionStatus, LiveFilter } from "./live.js";
import type { OwnedRelicsPage, RelicCollection, RelicCollectionInput, RelicFeedInput } from "./relics.js";
import type { RelicCollectionStats, RelicStatsFilter } from "./relicStats.js";
import type {
  Address,
  AnalyticsSnapshot,
  CageCallsActivity,
  ContractName,
  DataResult,
  Felt,
  Fight,
  FightBuy,
  FightEvent,
  FightFeedItem,
  FightPotState,
  FightViewerState,
  FightWinner,
  Fighter,
  GachaPoolState,
  GachaUserState,
  Market,
  MarketPosition,
  MarketState,
  Page,
  RawCageCallsEvent,
  RegisteredAsset,
  Relic,
  RoleMembership,
} from "./types.js";

const CageCallsContext = createContext<CageCallsClient | undefined>(undefined);

export function CageCallsProvider({ client, children }: { client: CageCallsClient; children: ReactNode }) {
  return createElement(CageCallsContext.Provider, { value: client }, children);
}

export function useCageCallsClient(): CageCallsClient {
  const value = useContext(CageCallsContext);
  if (!value) throw new Error("CageCallsProvider is missing.");
  return value;
}

type Options<T> = Omit<UseQueryOptions<T, Error>, "queryKey" | "queryFn">;
type FightersInput = { active?: boolean; limit?: number; cursor?: string };
type FightsInput = { limit?: number; cursor?: string; seasonId?: bigint };
type FightFeedInput = { limit?: number; cursor?: bigint; viewer?: Address };
type FightEventsInput = FightFeedInput & { now?: bigint };
type OffsetPageInput = { offset?: number; limit?: number };
type CursorPageInput = { limit?: number; cursor?: string };
type GachaTokensInput = { cursor?: bigint; limit?: number };
type ActivityInput = { limit?: number; cursor?: string; keys?: string[] };

export function useFighter(fighterId: bigint, options?: Options<DataResult<Fighter>>) {
  const client = useCageCallsClient();
  return useQuery({ queryKey: keys.fighter(fighterId), queryFn: ({ signal }) => client.fighters.get(fighterId, { signal }), refetchOnWindowFocus: false, ...options });
}

export function useFighters(input: FightersInput = {}, options?: Options<DataResult<Page<Fighter>>>) {
  const client = useCageCallsClient();
  return useQuery({ queryKey: keys.fighters(input), queryFn: ({ signal }) => client.fighters.page(input, { signal }), refetchOnWindowFocus: false, ...options });
}

export function useFightersMany(fighterIds: readonly bigint[], options?: Options<DataResult<Fighter[]>>) {
  const client = useCageCallsClient();
  return useQuery({ queryKey: keys.fightersMany(fighterIds), queryFn: ({ signal }) => client.fighters.getMany(fighterIds, { signal }), refetchOnWindowFocus: false, ...options });
}

export function useFighterAdmin(account: Address, options?: Options<DataResult<boolean>>) {
  const client = useCageCallsClient();
  return useQuery({ queryKey: keys.admin(`fighter:${normalizeAddress(account)}`), queryFn: ({ signal }) => client.fighters.isAdmin(account, { signal }), refetchOnWindowFocus: false, ...options });
}

export function useFight(fightId: bigint, options?: Options<DataResult<Fight>>) {
  const client = useCageCallsClient();
  return useQuery({ queryKey: keys.fight(fightId), queryFn: ({ signal }) => client.fights.get(fightId, { signal }), refetchOnWindowFocus: false, ...options });
}

export function useFights(input: FightsInput = {}, options?: Options<DataResult<Page<Fight>>>) {
  const client = useCageCallsClient();
  return useQuery({ queryKey: keys.fights(input), queryFn: ({ signal }) => client.fights.page(input, { signal }), refetchOnWindowFocus: false, ...options });
}

export function useFightFeed(input: FightFeedInput = {}, options?: Options<DataResult<Page<FightFeedItem, bigint>>>) {
  const client = useCageCallsClient();
  return useQuery({ queryKey: keys.fightFeed(input), queryFn: ({ signal }) => client.fights.feed(input, { signal }), refetchOnWindowFocus: false, ...options });
}

export function useFightEvents(input: FightEventsInput = {}, options?: Options<DataResult<Page<FightEvent, bigint>>>) {
  const client = useCageCallsClient();
  return useQuery({ queryKey: keys.fightEvents(input), queryFn: ({ signal }) => client.fightEvents.page(input, { signal }), refetchOnWindowFocus: false, ...options });
}

const keepComplete = <T,>(previous: DataResult<T> | undefined) => previous?.meta.complete ? previous : undefined;

export function useEventSnapshot(ref: EventRef, options?: Options<DataResult<PublicEventSnapshot>>) {
  const client = useCageCallsClient();
  return useQuery({ queryKey: keys.event(ref), queryFn: ({ signal }) => client.events.get(ref, { signal }), placeholderData: keepComplete, refetchOnWindowFocus: false, ...options });
}

export function useAccountEvent(ref: EventRef, account: Address, options?: Options<DataResult<AccountEventState>>) {
  const client = useCageCallsClient();
  return useQuery({ queryKey: keys.accountEvent(account, ref), queryFn: ({ signal }) => client.accounts.event(ref, account, { signal }), placeholderData: keepComplete, refetchOnWindowFocus: false, ...options });
}

export function useAccountPortfolio(account: Address, options?: Options<DataResult<AccountPortfolio>>) {
  const client = useCageCallsClient();
  return useQuery({ queryKey: keys.accountPortfolio(account), queryFn: ({ signal }) => client.accounts.portfolio(account, { signal }), placeholderData: keepComplete, refetchOnWindowFocus: false, ...options });
}

export function useFightBuys(fightId: bigint, input: OffsetPageInput = {}, options?: Options<DataResult<Page<FightBuy, number>>>) {
  const client = useCageCallsClient();
  return useQuery({ queryKey: keys.fightBuys(fightId, input), queryFn: ({ signal }) => client.fights.buys(fightId, input, { signal }), refetchOnWindowFocus: false, ...options });
}

export function useFightViewerState(fightId: bigint, viewer: Address, options?: Options<DataResult<FightViewerState>>) {
  const client = useCageCallsClient();
  return useQuery({ queryKey: [...keys.fight(fightId), "viewer", normalizeAddress(viewer)], queryFn: ({ signal }) => client.fights.viewerState(fightId, viewer, { signal }), refetchOnWindowFocus: false, ...options });
}

export function useFightPotState(fightId: bigint, options?: Options<DataResult<FightPotState>>) {
  const client = useCageCallsClient();
  return useQuery({ queryKey: [...keys.fight(fightId), "pot"], queryFn: ({ signal }) => client.fights.potState(fightId, { signal }), refetchOnWindowFocus: false, ...options });
}

export function useFightWinner(fightId: bigint, account: Address, options?: Options<DataResult<FightWinner | undefined>>) {
  const client = useCageCallsClient();
  return useQuery({ queryKey: [...keys.fight(fightId), "winner", normalizeAddress(account)], queryFn: ({ signal }) => client.fights.winner(fightId, account, { signal }), refetchOnWindowFocus: false, ...options });
}

export function useFightPortfolio(account: Address, input: CursorPageInput = {}, options?: Options<DataResult<Page<FightBuy>>>) {
  const client = useCageCallsClient();
  return useQuery({ queryKey: keys.portfolio(account, input), queryFn: ({ signal }) => client.fights.portfolio(account, input, { signal }), refetchOnWindowFocus: false, ...options });
}

export function useMarket(marketId: bigint, options?: Options<DataResult<Market>>) {
  const client = useCageCallsClient();
  return useQuery({ queryKey: keys.market(marketId), queryFn: ({ signal }) => client.markets.get(marketId, { signal }), refetchOnWindowFocus: false, ...options });
}

export function useMarkets(input: CursorPageInput = {}, options?: Options<DataResult<Page<Market>>>) {
  const client = useCageCallsClient();
  return useQuery({ queryKey: keys.markets(input), queryFn: ({ signal }) => client.markets.page(input, { signal }), refetchOnWindowFocus: false, ...options });
}

export function useMarketState(marketId: bigint, outcomeSlotCount: number, conditionId?: bigint, options?: Options<DataResult<MarketState>>) {
  const client = useCageCallsClient();
  return useQuery({ queryKey: [...keys.market(marketId), "state", outcomeSlotCount, conditionId?.toString() ?? "market"], queryFn: ({ signal }) => client.markets.state(marketId, outcomeSlotCount, conditionId, { signal }), refetchOnWindowFocus: false, ...options });
}

export function useMarketPosition(positionId: bigint, options?: Options<DataResult<MarketPosition>>) {
  const client = useCageCallsClient();
  return useQuery({ queryKey: ["cage-calls", "market-position", positionId.toString()], queryFn: ({ signal }) => client.markets.position(positionId, { signal }), refetchOnWindowFocus: false, ...options });
}

export function useConditionalBalance(account: Address, positionId: bigint, options?: Options<DataResult<bigint>>) {
  const client = useCageCallsClient();
  return useQuery({ queryKey: keys.tokens(account, `conditional:${positionId}`), queryFn: ({ signal }) => client.markets.conditionalBalance(account, positionId, { signal }), refetchOnWindowFocus: false, ...options });
}

export function useRelic(tokenId: bigint, options?: Options<DataResult<Relic>>) {
  const client = useCageCallsClient();
  return useQuery({ queryKey: keys.relic(tokenId), queryFn: ({ signal }) => client.relics.get(tokenId, { signal }), refetchOnWindowFocus: false, ...options });
}

export function useRelicsMany(tokenIds: readonly bigint[], options?: Options<DataResult<Relic[]>>) {
  const client = useCageCallsClient();
  return useQuery({ queryKey: keys.relicsMany(tokenIds), queryFn: ({ signal }) => client.relics.getMany(tokenIds, { signal }), refetchOnWindowFocus: false, ...options });
}

export function useRelicFeed(input: RelicFeedInput = {}, options?: Options<DataResult<Page<Relic, bigint>>>) {
  const client = useCageCallsClient();
  return useQuery({ queryKey: keys.relics(input), queryFn: ({ signal }) => client.relics.page(input, { signal }), refetchOnWindowFocus: false, ...options });
}

export function useRelicCollection(input: RelicCollectionInput = {}, options?: Options<DataResult<RelicCollection>>) {
  const client = useCageCallsClient();
  return useQuery({ queryKey: keys.relicCollection(input), queryFn: ({ signal }) => client.relics.collection(input, { signal }), refetchOnWindowFocus: false, ...options });
}

export function useRelicStats(filter: RelicStatsFilter = {}, options?: Options<DataResult<RelicCollectionStats>>) {
  const client = useCageCallsClient();
  return useQuery({ queryKey: keys.relicStats(filter), queryFn: ({ signal }) => client.relics.stats(filter, { signal }), refetchOnWindowFocus: false, ...options });
}

export function useOwnedRelics(account: Address, options?: Options<DataResult<OwnedRelicsPage>>) {
  const client = useCageCallsClient();
  return useQuery({ queryKey: keys.ownedRelics(account), queryFn: ({ signal }) => client.relics.owned(account, { signal }), refetchOnWindowFocus: false, ...options });
}

export function useRelicMetadata(tokenId: bigint, options?: Options<DataResult<Relic>>) {
  const client = useCageCallsClient();
  return useQuery({ queryKey: [...keys.relic(tokenId), "metadata"], queryFn: ({ signal }) => client.relics.metadata(tokenId, { signal }), refetchOnWindowFocus: false, ...options });
}

export function useRelicOwner(tokenId: bigint, options?: Options<DataResult<Address>>) {
  const client = useCageCallsClient();
  return useQuery({ queryKey: [...keys.relic(tokenId), "owner"], queryFn: ({ signal }) => client.relics.owner(tokenId, { signal }), refetchOnWindowFocus: false, ...options });
}

export function useGachaPool(fightId: bigint, options?: Options<DataResult<GachaPoolState>>) {
  const client = useCageCallsClient();
  return useQuery({ queryKey: keys.gacha(fightId), queryFn: ({ signal }) => client.gacha.pool(fightId, { signal }), refetchOnWindowFocus: false, ...options });
}

export function useGachaUser(fightId: bigint, account: Address, options?: Options<DataResult<GachaUserState>>) {
  const client = useCageCallsClient();
  return useQuery({ queryKey: keys.gachaUser(fightId, account), queryFn: ({ signal }) => client.gacha.user(fightId, account, { signal }), refetchOnWindowFocus: false, ...options });
}

export function useGachaAvailableTokenIds(fightId: bigint, input: GachaTokensInput = {}, options?: Options<DataResult<Page<bigint, bigint>>>) {
  const client = useCageCallsClient();
  return useQuery({ queryKey: keys.gachaTokens(fightId, input), queryFn: ({ signal }) => client.gacha.availableTokenIds(fightId, input, { signal }), refetchOnWindowFocus: false, ...options });
}

export function useGachaAdmin(account: Address, options?: Options<DataResult<boolean>>) {
  const client = useCageCallsClient();
  return useQuery({ queryKey: keys.admin(`gacha:${normalizeAddress(account)}`), queryFn: ({ signal }) => client.gacha.isAdmin(account, { signal }), refetchOnWindowFocus: false, ...options });
}

export function useGachaVrfAddress(options?: Options<DataResult<Address>>) {
  const client = useCageCallsClient();
  return useQuery({ queryKey: keys.admin("gacha-vrf"), queryFn: ({ signal }) => client.gacha.vrfAddress({ signal }), refetchOnWindowFocus: false, ...options });
}

export function useCallsBalance(account: Address, options?: Options<DataResult<bigint>>) {
  const client = useCageCallsClient();
  return useQuery({ queryKey: keys.tokens(account, "calls-balance"), queryFn: ({ signal }) => client.tokens.callsBalance(account, { signal }), refetchOnWindowFocus: false, ...options });
}

export function useCallsAllowance(owner: Address, spender?: Address, options?: Options<DataResult<bigint>>) {
  const client = useCageCallsClient();
  return useQuery({ queryKey: keys.tokens(owner, `calls-allowance:${spender ? normalizeAddress(spender) : "markets"}`), queryFn: ({ signal }) => client.tokens.callsAllowance(owner, spender, { signal }), refetchOnWindowFocus: false, ...options });
}

export function useStrikeTicketBalance(account: Address, fightId: bigint, options?: Options<DataResult<bigint>>) {
  const client = useCageCallsClient();
  return useQuery({ queryKey: keys.tokens(account, `strike:${fightId}`), queryFn: ({ signal }) => client.tokens.strikeTicketBalance(account, fightId, { signal }), refetchOnWindowFocus: false, ...options });
}

export function useVaultPositionBalance(account: Address, positionId: bigint, options?: Options<DataResult<bigint>>) {
  const client = useCageCallsClient();
  return useQuery({ queryKey: keys.tokens(account, `vault:${positionId}`), queryFn: ({ signal }) => client.tokens.vaultPositionBalance(account, positionId, { signal }), refetchOnWindowFocus: false, ...options });
}

export function useTokenApproval(token: "StrikeTickets" | "VaultPositions" | "ConditionalTokens", owner: Address, operator: Address, options?: Options<DataResult<boolean>>) {
  const client = useCageCallsClient();
  return useQuery({ queryKey: keys.tokens(owner, `${token}:approval:${normalizeAddress(operator)}`), queryFn: ({ signal }) => client.tokens.isApprovedForAll(token, owner, operator, { signal }), refetchOnWindowFocus: false, ...options });
}

export function useActivity(input: ActivityInput = {}, options?: Options<DataResult<Page<CageCallsActivity>>>) {
  const client = useCageCallsClient();
  return useQuery({ queryKey: keys.activity(input), queryFn: ({ signal }) => client.activity.page(input, { signal }), refetchOnWindowFocus: false, ...options });
}

export function useRawActivity(input: ActivityInput = {}, options?: Options<DataResult<Page<RawCageCallsEvent>>>) {
  const client = useCageCallsClient();
  return useQuery({ queryKey: [...keys.activity(input), "raw"], queryFn: ({ signal }) => client.activity.raw(input, { signal }), refetchOnWindowFocus: false, ...options });
}

export function useAnalyticsSnapshot(options?: Options<DataResult<AnalyticsSnapshot>>) {
  const client = useCageCallsClient();
  return useQuery({ queryKey: keys.analytics(), queryFn: ({ signal }) => client.analytics.snapshot({ signal }), refetchOnWindowFocus: false, ...options });
}

export function useAnalyticsSummary(filter: AnalyticsSummaryFilter = {}, options?: Options<DataResult<CageCallsAnalyticsSummary>>) {
  const client = useCageCallsClient();
  return useQuery({ queryKey: keys.analyticsSummary(filter), queryFn: ({ signal }) => client.analytics.summary(filter, { signal }), refetchOnWindowFocus: false, ...options });
}

export function useAdminStatus(contract: "FightFactory" | "FighterRegistry" | "Gacha" | "CageCallsOracle", account: Address, options?: Options<DataResult<boolean>>) {
  const client = useCageCallsClient();
  return useQuery({ queryKey: keys.admin(`${contract}:${normalizeAddress(account)}`), queryFn: ({ signal }) => client.admin.isAdmin(contract, account, { signal }), refetchOnWindowFocus: false, ...options });
}

export function useRole(contract: ContractName, role: Felt, account: Address, options?: Options<DataResult<boolean>>) {
  const client = useCageCallsClient();
  return useQuery({ queryKey: keys.admin(`${contract}:${role}:${normalizeAddress(account)}`), queryFn: ({ signal }) => client.admin.hasRole(contract, role, account, { signal }), refetchOnWindowFocus: false, ...options });
}

export function useRoles(options?: Options<DataResult<RoleMembership[]>>) {
  const client = useCageCallsClient();
  return useQuery({ queryKey: keys.admin("roles"), queryFn: ({ signal }) => client.admin.roles({ signal }), refetchOnWindowFocus: false, ...options });
}

export function useRegisteredTokens(input: CursorPageInput = {}, options?: Options<DataResult<Page<RegisteredAsset>>>) {
  const client = useCageCallsClient();
  return useQuery({ queryKey: keys.admin(`tokens:${input.limit ?? "default"}:${input.cursor ?? "start"}`), queryFn: ({ signal }) => client.admin.registeredTokens(input, { signal }), refetchOnWindowFocus: false, ...options });
}

export function useRegisteredOracles(input: CursorPageInput = {}, options?: Options<DataResult<Page<RegisteredAsset>>>) {
  const client = useCageCallsClient();
  return useQuery({ queryKey: keys.admin(`oracles:${input.limit ?? "default"}:${input.cursor ?? "start"}`), queryFn: ({ signal }) => client.admin.registeredOracles(input, { signal }), refetchOnWindowFocus: false, ...options });
}

export function useMarketsPaused(options?: Options<DataResult<boolean>>) {
  const client = useCageCallsClient();
  return useQuery({ queryKey: keys.admin("markets-paused"), queryFn: ({ signal }) => client.admin.marketsPaused({ signal }), refetchOnWindowFocus: false, ...options });
}

export function useOracleWinner(marketId: bigint, options?: Options<DataResult<bigint | undefined>>) {
  const client = useCageCallsClient();
  return useQuery({ queryKey: keys.admin(`oracle-winner:${marketId}`), queryFn: ({ signal }) => client.admin.oracleWinner(marketId, { signal }), refetchOnWindowFocus: false, ...options });
}

function liveInvalidationKeys(update: CageCallsLiveUpdate): readonly (readonly unknown[])[] {
  switch (update.kind) {
    case "fighter": return [keys.fighter(update.fighterId), keys.fighters(), keys.relicStats()];
    case "fight": return [keys.fight(update.fightId), keys.fights(), keys.fightFeed(), keys.analytics()];
    case "market": return [keys.market(update.marketId), keys.markets(), keys.analytics()];
    case "relic": return [keys.relic(update.tokenId), keys.relics(), keys.relicCollection(), keys.relicStats(), ...(update.owner ? [keys.ownedRelics(update.owner), keys.accountPortfolio(update.owner)] : [])];
    case "gacha": return [keys.gacha(update.fightId), ...(update.account ? [keys.gachaUser(update.fightId, update.account), keys.accountPortfolio(update.account)] : [])];
    case "token-balance": return [keys.tokens(update.account), keys.accountPortfolio(update.account)];
    case "activity": return [keys.activity(), keys.analytics()];
    case "reconcile": return [["cage-calls"]];
  }
}

export function useCageCallsLive(
  filter: LiveFilter = {},
  callbacks: { onUpdate?(update: CageCallsLiveUpdate): void; onStatus?(status: LiveConnectionStatus): void; onError?(error: unknown): void } = {},
): boolean {
  const client = useCageCallsClient();
  const queryClient = useQueryClient();
  const callbacksRef = useRef(callbacks);
  callbacksRef.current = callbacks;
  const kinds = filter.kinds?.join(",") ?? "all";
  const account = filter.account ? normalizeAddress(filter.account) : "all";
  const event = filter.event ? `${filter.event.seasonId}:${filter.event.eventName}` : "all";
  useEffect(() => {
    if (!client.live.available) return;
    let active = true;
    let unsubscribe: (() => void | Promise<void>) | undefined;
    void client.live.subscribe(filter, {
      update(update) {
        if (!active) return;
        callbacksRef.current.onUpdate?.(update);
        for (const queryKey of liveInvalidationKeys(update)) void queryClient.invalidateQueries({ queryKey });
      },
      status(status) { if (active) callbacksRef.current.onStatus?.(status); },
      error(error) { if (active) callbacksRef.current.onError?.(error); },
    }).then((subscription) => {
      if (!active) void subscription.unsubscribe();
      else unsubscribe = () => subscription.unsubscribe();
    }).catch((error) => { if (active) callbacksRef.current.onError?.(error); });
    return () => {
      active = false;
      if (unsubscribe) void unsubscribe();
    };
  }, [client, queryClient, kinds, account, event]);
  return client.live.available;
}

export { cageCallsQueryKeys } from "./queryKeys.js";
