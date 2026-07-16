import { normalizeAddress, normalizeFelt } from "./codecs.js";
import { ConfigurationError, ValidationError } from "./errors.js";
import { NETWORK_PRESETS } from "./generated/deployments.js";
import type {
  CageCallsNetwork,
  CapabilityName,
  ContractName,
  DeploymentCapabilities,
  DeploymentClassHashes,
  DeploymentContracts,
  NetworkName,
} from "./types.js";
import type { RpcTransport } from "./transports.js";

const CONTRACT_NAMES: readonly ContractName[] = [
  "CALLS",
  "CageCallsOracle",
  "ConditionalTokens",
  "FightFactory",
  "FighterRegistry",
  "Gacha",
  "Markets",
  "RelicNFT",
  "StrikeTickets",
  "VaultFees",
  "VaultPositions",
];

const CAPABILITY_PROBES: Readonly<Record<CapabilityName, { contract: ContractName; entrypoint: string; calldata: string[] }>> = {
  fightFeed: { contract: "FightFactory", entrypoint: "get_fight_feed", calldata: ["0", "0", "0", "0"] },
  fightBuyPagination: { contract: "FightFactory", entrypoint: "get_fight_buys", calldata: ["0", "0", "0", "0"] },
  relicFeed: { contract: "RelicNFT", entrypoint: "get_relic_feed", calldata: ["0", "0", "0"] },
  relicBatch: { contract: "RelicNFT", entrypoint: "get_relics", calldata: ["0"] },
  relicOwnerPage: { contract: "RelicNFT", entrypoint: "get_owned_relics", calldata: ["0", "0", "0", "0", "0"] },
  fighterBatch: { contract: "FighterRegistry", entrypoint: "get_fighters", calldata: ["0"] },
  gachaPoolAggregate: { contract: "Gacha", entrypoint: "get_pool_states", calldata: ["0"] },
  gachaAvailableTokenIds: { contract: "Gacha", entrypoint: "get_available_token_ids", calldata: ["0", "0", "0", "0", "0"] },
  accountFightFeed: { contract: "FightFactory", entrypoint: "get_account_fight_feed", calldata: ["0", "0", "0", "0", "0"] },
  gachaUserStates: { contract: "Gacha", entrypoint: "get_user_states", calldata: ["0", "0"] },
};

const RUNTIME_PROBE_CAPABILITIES = new Set<CapabilityName>(["accountFightFeed", "gachaUserStates"]);

function validateUrl(value: string, label: string): string {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("protocol");
    return url.toString().replace(/\/$/, "");
  } catch {
    throw new ConfigurationError(`${label} must be an HTTP(S) URL.`);
  }
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

export function validateCustomNetwork(input: CageCallsNetwork): Readonly<CageCallsNetwork> {
  if (!input.name.trim()) throw new ConfigurationError("Custom network name is required.");
  if (!input.namespace.trim()) throw new ConfigurationError("Custom network namespace is required.");
  if (!input.deploymentRevision.trim()) throw new ConfigurationError("Custom network deploymentRevision is required.");

  const contracts = {} as Record<ContractName, ReturnType<typeof normalizeAddress>>;
  const classHashes = {} as Record<ContractName, ReturnType<typeof normalizeFelt>>;
  for (const name of CONTRACT_NAMES) {
    const address = input.contracts[name];
    const classHash = input.classHashes[name];
    if (!address || !classHash) throw new ConfigurationError(`Custom network is missing ${name}.`);
    contracts[name] = normalizeAddress(address, `${name} address`);
    classHashes[name] = normalizeFelt(classHash, `${name} class hash`);
  }

  const network: CageCallsNetwork = {
    name: input.name.trim(),
    ...(input.preset ? { preset: input.preset } : {}),
    chainId: normalizeFelt(input.chainId, "chainId"),
    namespace: input.namespace.trim(),
    deploymentRevision: input.deploymentRevision.trim(),
    worldAddress: normalizeAddress(input.worldAddress, "worldAddress"),
    contracts: contracts as DeploymentContracts,
    classHashes: classHashes as DeploymentClassHashes,
    toriiUrl: validateUrl(input.toriiUrl, "Torii URL"),
    cartridgeRpcUrl: validateUrl(input.cartridgeRpcUrl, "Cartridge RPC URL"),
    vrfAddress: normalizeAddress(input.vrfAddress, "VRF address"),
    capabilities: { ...input.capabilities },
  };
  return deepFreeze(network);
}

export function resolveNetwork(value: NetworkName | CageCallsNetwork): Readonly<CageCallsNetwork> {
  if (typeof value === "string") {
    const preset = NETWORK_PRESETS[value];
    if (!preset) throw new ValidationError(`Unknown Cage Calls network ${value}.`);
    return preset;
  }
  return validateCustomNetwork(value);
}

export interface CapabilityRegistry {
  has(capability: CapabilityName): boolean;
  probe(capability: CapabilityName, signal?: AbortSignal): Promise<boolean>;
  snapshot(): Readonly<DeploymentCapabilities>;
}

export function createCapabilityRegistry(network: CageCallsNetwork, rpc: RpcTransport): CapabilityRegistry {
  const values: DeploymentCapabilities = { ...network.capabilities };
  const unsupported = new Set<CapabilityName>();
  const pending = new Map<CapabilityName, Promise<boolean>>();

  const probe = async (capability: CapabilityName, signal?: AbortSignal): Promise<boolean> => {
    if (values[capability]) return true;
    if (unsupported.has(capability)) return false;
    // Generated deployment presets are authoritative. Probing a known-false
    // capability only spends RPC budget on an entrypoint that cannot exist.
    if (network.preset && !RUNTIME_PROBE_CAPABILITIES.has(capability)) {
      unsupported.add(capability);
      return false;
    }
    const active = pending.get(capability);
    if (active) return active;
    const definition = CAPABILITY_PROBES[capability];
    const task = rpc.call({
      contractAddress: network.contracts[definition.contract],
      entrypoint: definition.entrypoint,
      calldata: definition.calldata,
    }, signal ? { signal } : {}).then(() => {
      values[capability] = true;
      return true;
    }).catch(() => {
      unsupported.add(capability);
      return false;
    }).finally(() => pending.delete(capability));
    pending.set(capability, task);
    return task;
  };

  return {
    has(capability) {
      return values[capability] && !unsupported.has(capability);
    },
    probe,
    snapshot() {
      return Object.freeze({ ...values });
    },
  };
}

export { NETWORK_PRESETS } from "./generated/deployments.js";
export { MAINNET_PRESET, SEPOLIA_DEV_PRESET, SEPOLIA_STAGING_PRESET, UPSTREAM_DEPLOYMENTS } from "./generated/deployments.js";
