import { createActivityRepository, type ActivityRepository } from "./activity.js";
import { createAggregateRepositories, type AccountsRepository, type EventsRepository } from "./aggregates.js";
import { createAdminRepository, type AdminRepository } from "./admin.js";
import { createAnalyticsRepository, type AnalyticsRepository } from "./analytics.js";
import { resolveBudget } from "./core.js";
import { ConfigurationError } from "./errors.js";
import { createCapabilityRegistry, resolveNetwork, type CapabilityRegistry } from "./network.js";
import {
  createFightEventsRepository,
  createFightersRepository,
  createFightsRepository,
  createGachaRepository,
  createMarketsRepository,
  createTokensRepository,
  type FightersRepository,
  type FightEventsRepository,
  type FightsRepository,
  type GachaRepository,
  type MarketsRepository,
  type RepositoryContext,
  type TokensRepository,
} from "./repositories.js";
import { createRelicsRepository, type RelicsRepository } from "./relics.js";
import {
  createResilientMetadataTransport,
  createResilientRpcTransport,
  createResilientToriiTransport,
  createSourceStatusRegistry,
  type PassiveCircuitOptions,
  type SourceStatusRegistry,
} from "./resilience.js";
import { createLiveRepository, type CageCallsLiveTransport, type LiveRepository } from "./live.js";
import type { MetadataTransport, RpcTransport, ToriiTransport } from "./transports.js";
import type { CageCallsNetwork, NetworkName, RequestBudget, SdkLogger } from "./types.js";

export interface CageCallsTransports {
  rpc: RpcTransport;
  torii?: ToriiTransport;
  metadata?: MetadataTransport;
  live?: CageCallsLiveTransport;
}

export interface CreateCageCallsClientOptions {
  network: NetworkName | CageCallsNetwork;
  transports: CageCallsTransports;
  logger?: SdkLogger;
  budget?: Partial<RequestBudget>;
  now?: () => number;
  resilience?: PassiveCircuitOptions | false;
}

export interface CageCallsClient {
  readonly network: Readonly<CageCallsNetwork>;
  readonly capabilities: CapabilityRegistry;
  readonly analytics: AnalyticsRepository;
  readonly fighters: FightersRepository;
  readonly fights: FightsRepository;
  readonly fightEvents: FightEventsRepository;
  readonly events: EventsRepository;
  readonly accounts: AccountsRepository;
  readonly markets: MarketsRepository;
  readonly relics: RelicsRepository;
  readonly gacha: GachaRepository;
  readonly tokens: TokensRepository;
  readonly activity: ActivityRepository;
  readonly admin: AdminRepository;
  readonly sources: SourceStatusRegistry;
  readonly live: LiveRepository;
}

export function createCageCallsClient(options: CreateCageCallsClientOptions): CageCallsClient {
  if (!options.transports?.rpc) throw new ConfigurationError("An RPC transport is required.");
  const network = resolveNetwork(options.network);
  const budget = resolveBudget(options.budget);
  const sources = createSourceStatusRegistry();
  const resilience = options.resilience === false ? undefined : { ...options.resilience, now: options.now ?? Date.now };
  const rpc = resilience
    ? createResilientRpcTransport(options.transports.rpc, sources, resilience)
    : options.transports.rpc;
  const torii = options.transports.torii && resilience
    ? createResilientToriiTransport(options.transports.torii, sources, resilience)
    : options.transports.torii;
  const metadata = options.transports.metadata && resilience
    ? createResilientMetadataTransport(options.transports.metadata, sources, resilience)
    : options.transports.metadata;
  const capabilities = createCapabilityRegistry(network, rpc);
  const context: RepositoryContext = {
    network,
    rpc,
    ...(torii ? { torii } : {}),
    capabilities,
    budget,
    now: options.now ?? Date.now,
    ...(options.logger ? { logger: options.logger } : {}),
  };
  const tokens = createTokensRepository(context);
  const fights = createFightsRepository(context);
  const gacha = createGachaRepository(context, tokens);
  const relics = createRelicsRepository({
    ...context,
    ...(metadata ? { metadata } : {}),
  });
  const aggregates = createAggregateRepositories(context, { fights, gacha, relics, tokens });
  return Object.freeze({
    network,
    capabilities,
    analytics: createAnalyticsRepository(context),
    fighters: createFightersRepository(context),
    fights,
    fightEvents: createFightEventsRepository(context, fights),
    events: aggregates.events,
    accounts: aggregates.accounts,
    markets: createMarketsRepository(context),
    relics,
    gacha,
    tokens,
    activity: createActivityRepository(context),
    admin: createAdminRepository(context),
    sources,
    live: createLiveRepository(options.transports.live),
  });
}
