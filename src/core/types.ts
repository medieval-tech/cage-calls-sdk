export type Hex = `0x${string}`;
export type Address = Hex;
export type Felt = Hex;

export type DataSource =
  | "torii"
  | "starknet-rpc"
  | "ipfs"
  | "derived";

export interface SourceAttempt {
  source: DataSource;
  ok: boolean;
  operation: string;
  durationMs: number;
  fallback?: boolean;
  status?: number;
  errorCode?: string;
}

export interface DataWarning {
  code: string;
  message: string;
  source?: DataSource;
}

export interface DataResult<T> {
  data: T;
  meta: {
    source: DataSource;
    complete: boolean;
    attempts: SourceAttempt[];
    warnings: DataWarning[];
    fetchedAt: number;
    durationMs: number;
    blockNumber?: bigint;
  };
}

export interface Page<T, Cursor = string> {
  items: T[];
  cursor?: Cursor;
  hasMore: boolean;
}

export type CageCallsQueryKey = readonly ["cage-calls", ...readonly unknown[]];

export type NetworkName = "mainnet" | "sepolia-dev" | "sepolia-staging";

export type ContractName =
  | "CALLS"
  | "CageCallsOracle"
  | "ConditionalTokens"
  | "FightFactory"
  | "FighterRegistry"
  | "Gacha"
  | "Markets"
  | "RelicNFT"
  | "StrikeTickets"
  | "VaultFees"
  | "VaultPositions";

export type DeploymentContracts = Readonly<Record<ContractName, Address>>;
export type DeploymentClassHashes = Readonly<Record<ContractName, Felt>>;

export type CapabilityName =
  | "fightFeed"
  | "fightFeedByIds"
  | "fightBuyPagination"
  | "relicFeed"
  | "relicBatch"
  | "relicOwnerPage"
  | "fighterBatch"
  | "gachaPoolAggregate"
  | "gachaAvailableTokenIds"
  | "accountFightFeed"
  | "gachaUserStates";

export interface DeploymentCapabilities {
  fightFeed: boolean;
  fightFeedByIds: boolean;
  fightBuyPagination: boolean;
  relicFeed: boolean;
  relicBatch: boolean;
  relicOwnerPage: boolean;
  fighterBatch: boolean;
  gachaPoolAggregate: boolean;
  gachaAvailableTokenIds: boolean;
  accountFightFeed: boolean;
  gachaUserStates: boolean;
}

export interface CageCallsNetwork {
  name: string;
  preset?: NetworkName;
  chainId: Felt;
  namespace: string;
  deploymentRevision: string;
  worldAddress: Address;
  contracts: DeploymentContracts;
  classHashes: DeploymentClassHashes;
  toriiUrl: string;
  cartridgeRpcUrl: string;
  vrfAddress: Address;
  capabilities: Readonly<DeploymentCapabilities>;
}

export interface TraversalLimits {
  maxRpcPages: number;
  maxRpcItems: number;
  maxToriiPages: number;
  maxToriiItems: number;
}

export interface RequestOptions {
  signal?: AbortSignal;
  /** Per-request deadline. It can only tighten the transport's configured timeout. */
  timeoutMs?: number;
  traversal?: Partial<TraversalLimits>;
  /** Preferred size for aggregate `get_relics` calls. The SDK splits failed batches adaptively. */
  relicBatchSize?: number;
}

export interface SdkLogger {
  debug?(message: string, context?: Readonly<Record<string, unknown>>): void;
  info?(message: string, context?: Readonly<Record<string, unknown>>): void;
  warn?(message: string, context?: Readonly<Record<string, unknown>>): void;
  error?(message: string, context?: Readonly<Record<string, unknown>>): void;
}

export interface RequestBudget extends TraversalLimits {
  timeoutMs: number;
  maxConcurrency: number;
  pageSize: number;
  relicBatchSize: number;
}

export interface Fighter {
  fighterId: bigint;
  name: string;
  weightClass: string;
  active: boolean;
}

export interface Fight {
  fightId: bigint;
  seasonId: bigint;
  eventName: string;
  marketId: bigint;
  fighterAId: bigint;
  fighterAName: string;
  fighterAWeightClass: string;
  choiceAValue: bigint;
  choiceALabel: string;
  fighterBId: bigint;
  fighterBName: string;
  fighterBWeightClass: string;
  choiceBValue: bigint;
  choiceBLabel: string;
  createdAt: bigint;
  isDev: boolean;
  sponsor: Felt;
}

export interface FightBuy {
  fightId: bigint;
  buyer: Address;
  marketId: bigint;
  choiceIndex: number;
  amount: bigint;
  boughtAt: bigint;
}

export interface FightWinner {
  fightId: bigint;
  winner: Address;
  choiceIndex: number;
  redeemed: boolean;
}

export interface FightViewerState {
  hasBought: boolean;
  choiceIndex?: number;
  shares: bigint;
  boughtAt: bigint;
  hasRedeemed: boolean;
  isWinner: boolean;
  strikeTickets: bigint;
}

export interface FightPotState {
  total: bigint;
  claimed: bigint;
  winnerIndex?: number;
  winnersCount: bigint;
  closed: boolean;
  settled: boolean;
}

export interface FightFeedItem extends Fight {
  marketCreatedAt: bigint;
  conditionId: bigint;
  oracle: Address;
  outcomeSlotCount: number;
  collateralToken: Address;
  startAt: bigint;
  endAt: bigint;
  resolveAt: bigint;
  resolvedAt: bigint;
  vaultNumerators: bigint[];
  vaultDenominator: bigint;
  outcomeCounts: bigint[];
  outcomeShares: bigint[];
  payoutNumerators: bigint[];
  payoutDenominator: bigint;
  pot: FightPotState;
  viewer: FightViewerState;
}

export interface FightEvent {
  seasonId: bigint;
  eventName: string;
  fights: FightFeedItem[];
  lifecycle: "upcoming" | "open" | "closed" | "settled" | "mixed";
}

export interface Market {
  marketId: bigint;
  creator: Address;
  createdAt: bigint;
  questionId?: bigint;
  conditionId: bigint;
  oracle: Address;
  outcomeSlotCount: number;
  collateralToken: Address;
  startAt?: bigint;
  endAt?: bigint;
  resolveAt?: bigint;
  resolvedAt?: bigint;
}

export interface AnalyticsSnapshot {
  fights: Fight[];
  buys: FightBuy[];
  winnerChoiceByFight: Record<string, number>;
}

export interface MarketCatalogItem {
  market: Market;
  fight?: Fight;
  vaultNumerators: bigint[];
  vaultDenominator: bigint;
}

export interface MarketState {
  market: Market;
  vaultNumerators: bigint[];
  vaultDenominator: bigint;
  payoutNumerators: bigint[];
  payoutDenominator: bigint;
  outcomeShares?: bigint[];
}

export interface MarketPosition {
  marketId: bigint;
  positionId: bigint;
  owner?: Address;
  outcomeIndex?: number;
  value?: bigint;
}

export interface RelicMetadataAttribute {
  traitType?: string;
  value?: string | number | boolean | null;
}

export interface RelicMetadata {
  definitionId: bigint;
  seasonId: bigint;
  fightId: bigint;
  fighterId: bigint;
  opponentId: bigint;
  sponsor: string;
  relicIndex: number;
  fightTimestamp: bigint;
  mediaUri: string;
  mediaType: number;
  category: number;
  moveType: string;
  moveName: string;
  tags: bigint;
  intent: number;
  effectVector: number;
  targetZone: number;
  power: number;
  speed: number;
  control: number;
  risk: number;
  complexity: number;
  versatility: number;
  comboFlags: number;
  linkableToTags: bigint;
  requiresTagsBefore: bigint;
  rarity: number;
  relicType: string;
  style: string;
  weightClass: string;
}

export interface Relic {
  tokenId: bigint;
  owner?: Address;
  definitionId?: bigint;
  editionNumber?: bigint;
  eventName?: string;
  tokenUri?: string;
  metadata?: RelicMetadata;
  name?: string;
  description?: string;
  image?: string;
  animationUrl?: string;
  attributes: RelicMetadataAttribute[];
  ownershipSource?: DataSource;
  metadataSources?: DataSource[];
}

export interface RelicOwnershipProvenance {
  owner: Address;
  onchainBalance: bigint;
  ownershipSource: "torii" | "starknet-rpc";
  verified: boolean;
}

export interface GachaRarityState {
  rarity: number;
  expected: bigint;
  registered: bigint;
  available: bigint;
}

export interface GachaPoolState {
  fightId: bigint;
  open: boolean;
  size: bigint;
  rarities: GachaRarityState[];
  availableTokenIds?: bigint[];
}

export interface GachaUserState {
  fightId: bigint;
  user: Address;
  escrowedTokenId?: bigint;
  strikeNonce: bigint;
  ticketBalance: bigint;
}

export interface GachaFightUserState extends GachaUserState {
  pool: GachaPoolState;
}

export interface GachaUserStates {
  user: Address;
  strikeNonce: bigint;
  states: GachaFightUserState[];
}

export interface RawCageCallsEvent {
  selector?: Felt;
  name?: string;
  contract: Address;
  transactionHash?: Hex;
  blockNumber?: bigint;
  timestamp?: bigint;
  keys: Felt[];
  data: Felt[];
  raw: unknown;
}

interface ActivityBase {
  network: string;
  contract: Address;
  transactionHash?: Hex;
  blockNumber?: bigint;
  timestamp?: bigint;
  raw: RawCageCallsEvent;
}

export type CageCallsActivity =
  | (ActivityBase & { type: "fight-created"; fightId?: bigint; payload: Record<string, unknown> })
  | (ActivityBase & { type: "market-buy"; marketId?: bigint; payload: Record<string, unknown> })
  | (ActivityBase & { type: "market-lifecycle"; marketId?: bigint; payload: Record<string, unknown> })
  | (ActivityBase & { type: "payout-redemption"; payload: Record<string, unknown> })
  | (ActivityBase & { type: "gacha-strike" | "gacha-keep"; fightId?: bigint; payload: Record<string, unknown> })
  | (ActivityBase & { type: "relic-transfer" | "relic-metadata-update"; tokenId?: bigint; payload: Record<string, unknown> })
  | (ActivityBase & { type: "fighter-registration" | "fighter-update" | "fighter-activation"; fighterId?: bigint; payload: Record<string, unknown> })
  | (ActivityBase & { type: "conditional-token"; action: "preparation" | "resolution" | "split" | "merge" | "redemption"; payload: Record<string, unknown> })
  | (ActivityBase & { type: "unknown"; payload: Record<string, unknown> });

export interface RoleMembership {
  contract: ContractName;
  account: Address;
  role: string;
  active: boolean;
}

export interface RegisteredAsset {
  contractAddress: Address;
  name?: string;
  symbol?: string;
  description?: string;
  decimals?: number;
  active: boolean;
}
