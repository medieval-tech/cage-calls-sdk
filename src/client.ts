import { createActivityRepository, type ActivityRepository } from "./activity.js";
import { createAdminRepository, type AdminRepository } from "./admin.js";
import { createCallBuilders, type CageCallsCallBuilders } from "./calls.js";
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
import type { MetadataTransport, RpcTransport, ToriiTransport } from "./transports.js";
import type { CageCallsNetwork, NetworkName, RequestBudget, SdkLogger } from "./types.js";

export interface CageCallsTransports {
  rpc: RpcTransport;
  torii?: ToriiTransport;
  metadata?: MetadataTransport;
}

export interface CreateCageCallsClientOptions {
  network: NetworkName | CageCallsNetwork;
  transports: CageCallsTransports;
  logger?: SdkLogger;
  budget?: Partial<RequestBudget>;
  now?: () => number;
}

export interface CageCallsClient {
  readonly network: Readonly<CageCallsNetwork>;
  readonly capabilities: CapabilityRegistry;
  readonly fighters: FightersRepository;
  readonly fights: FightsRepository;
  readonly fightEvents: FightEventsRepository;
  readonly markets: MarketsRepository;
  readonly relics: RelicsRepository;
  readonly gacha: GachaRepository;
  readonly tokens: TokensRepository;
  readonly activity: ActivityRepository;
  readonly admin: AdminRepository;
  readonly calls: CageCallsCallBuilders;
}

export function createCageCallsClient(options: CreateCageCallsClientOptions): CageCallsClient {
  if (!options.transports?.rpc) throw new ConfigurationError("An RPC transport is required.");
  const network = resolveNetwork(options.network);
  const budget = resolveBudget(options.budget);
  const capabilities = createCapabilityRegistry(network, options.transports.rpc);
  const context: RepositoryContext = {
    network,
    rpc: options.transports.rpc,
    ...(options.transports.torii ? { torii: options.transports.torii } : {}),
    capabilities,
    budget,
    now: options.now ?? Date.now,
    ...(options.logger ? { logger: options.logger } : {}),
  };
  const tokens = createTokensRepository(context);
  const fights = createFightsRepository(context);
  return Object.freeze({
    network,
    capabilities,
    fighters: createFightersRepository(context),
    fights,
    fightEvents: createFightEventsRepository(context, fights),
    markets: createMarketsRepository(context),
    relics: createRelicsRepository({
      ...context,
      ...(options.transports.metadata ? { metadata: options.transports.metadata } : {}),
    }),
    gacha: createGachaRepository(context, tokens),
    tokens,
    activity: createActivityRepository(context),
    admin: createAdminRepository(context),
    calls: createCallBuilders(network),
  });
}
