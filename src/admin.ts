import { createDataResult } from "./core.js";
import { normalizeAddress, normalizeFelt } from "./codecs.js";
import { decodeSingleBool, decodeSingleU256, scalarBoolean, scalarNumber, scalarString } from "./decoders.js";
import { UnsupportedCapabilityError, ValidationError } from "./errors.js";
import type { RepositoryContext } from "./repositories.js";
import type {
  Address,
  ContractName,
  DataResult,
  Felt,
  Page,
  RegisteredAsset,
  RequestOptions,
  RoleMembership,
} from "./types.js";

const ROLE_MODELS = {
  FightFactory: "FightFactoryAdmin",
  FighterRegistry: "FighterRegistryAdmin",
  Gacha: "GachaAdmin",
  CageCallsOracle: "OracleAdmin",
  RelicNFT: "RelicMinter",
} as const;

export interface AdminRepository {
  isAdmin(contract: "FightFactory" | "FighterRegistry" | "Gacha" | "CageCallsOracle", account: Address, options?: RequestOptions): Promise<DataResult<boolean>>;
  hasRole(contract: ContractName, role: Felt, account: Address, options?: RequestOptions): Promise<DataResult<boolean>>;
  roles(options?: RequestOptions): Promise<DataResult<RoleMembership[]>>;
  registeredTokens(input?: { limit?: number; cursor?: string }, options?: RequestOptions): Promise<DataResult<Page<RegisteredAsset>>>;
  registeredOracles(input?: { limit?: number; cursor?: string }, options?: RequestOptions): Promise<DataResult<Page<RegisteredAsset>>>;
  marketsPaused(options?: RequestOptions): Promise<DataResult<boolean>>;
  oracleWinner(marketId: bigint, options?: RequestOptions): Promise<DataResult<bigint | undefined>>;
}

export function createAdminRepository(context: RepositoryContext): AdminRepository {
  const rpc = async (contract: ContractName, entrypoint: string, calldata: string[], options: RequestOptions) =>
    context.rpc.call({ contractAddress: context.network.contracts[contract], entrypoint, calldata }, options);

  const assets = async (model: "RegisteredToken" | "RegisteredOracle", input: { limit?: number; cursor?: string }, options: RequestOptions) => {
    const startedAt = context.now();
    if (!context.torii) throw new UnsupportedCapabilityError(`${model} enumeration without Torii`);
    const selection = model === "RegisteredToken"
      ? ["contract_address", "name", "symbol", "decimals"]
      : ["contract_address", "name", "description"];
    const response = await context.torii.model<Record<string, unknown>>({
      model,
      selection,
      first: Math.min(Math.max(input.limit ?? 50, 1), context.budget.pageSize),
      ...(input.cursor ? { after: input.cursor } : {}),
    }, options);
    const items = response.data.edges.map(({ node }): RegisteredAsset => {
      const item: RegisteredAsset = {
        contractAddress: normalizeAddress(String(node.contract_address)),
        active: true,
      };
      if (node.name !== undefined) item.name = scalarString(node.name, "name");
      if (node.symbol !== undefined) item.symbol = scalarString(node.symbol, "symbol");
      if (node.description !== undefined) item.description = scalarString(node.description, "description");
      if (node.decimals !== undefined) item.decimals = scalarNumber(node.decimals, "decimals");
      return item;
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
      startedAt,
      now: context.now,
      ...(context.logger ? { logger: context.logger } : {}),
    });
  };

  return {
    async isAdmin(contract, account, options = {}) {
      const startedAt = context.now();
      const response = await rpc(contract, "is_admin", [normalizeAddress(account)], options);
      return createDataResult({ data: decodeSingleBool(response.data, `${contract}.isAdmin`), source: "starknet-rpc", complete: true, attempts: response.attempts, startedAt, now: context.now, ...(context.logger ? { logger: context.logger } : {}) });
    },
    async hasRole(contract, role, account, options = {}) {
      const startedAt = context.now();
      const response = await rpc(contract, "has_role", [normalizeFelt(role), normalizeAddress(account)], options);
      return createDataResult({ data: decodeSingleBool(response.data, `${contract}.hasRole`), source: "starknet-rpc", complete: true, attempts: response.attempts, startedAt, now: context.now, ...(context.logger ? { logger: context.logger } : {}) });
    },
    async roles(options = {}) {
      const startedAt = context.now();
      if (!context.torii) throw new UnsupportedCapabilityError("role enumeration without Torii");
      const values: RoleMembership[] = [];
      const attempts = [];
      for (const [contract, model] of Object.entries(ROLE_MODELS) as Array<[keyof typeof ROLE_MODELS, string]>) {
        const addressField = model === "RelicMinter" ? "minter" : "admin";
        const response = await context.torii.model<Record<string, unknown>>({ model, selection: [addressField, "active"], first: 100 }, options);
        attempts.push(...response.attempts);
        for (const edge of response.data.edges) {
          values.push({
            contract,
            account: normalizeAddress(String(edge.node[addressField])),
            role: model,
            active: scalarBoolean(edge.node.active, "active"),
          });
        }
      }
      return createDataResult({ data: values, source: "torii", complete: true, attempts, startedAt, now: context.now, ...(context.logger ? { logger: context.logger } : {}) });
    },
    registeredTokens(input = {}, options = {}) { return assets("RegisteredToken", input, options); },
    registeredOracles(input = {}, options = {}) { return assets("RegisteredOracle", input, options); },
    async marketsPaused(options = {}) {
      const startedAt = context.now();
      const response = await rpc("Markets", "is_paused", [], options).catch(() => rpc("Markets", "paused", [], options));
      return createDataResult({ data: decodeSingleBool(response.data, "marketsPaused"), source: "starknet-rpc", complete: true, attempts: response.attempts, startedAt, now: context.now, ...(context.logger ? { logger: context.logger } : {}) });
    },
    async oracleWinner(marketId, options = {}) {
      const startedAt = context.now();
      try {
        const response = await rpc("CageCallsOracle", "get_winner", [
          (marketId & ((1n << 128n) - 1n)).toString(),
          (marketId >> 128n).toString(),
        ], options);
        if (response.data.length === 0) return createDataResult({ data: undefined, source: "starknet-rpc", complete: true, attempts: response.attempts, startedAt, now: context.now, ...(context.logger ? { logger: context.logger } : {}) });
        const variant = Number(BigInt(response.data[0] ?? "0"));
        if (variant === 1) return createDataResult({ data: undefined, source: "starknet-rpc", complete: true, attempts: response.attempts, startedAt, now: context.now, ...(context.logger ? { logger: context.logger } : {}) });
        if (variant !== 0) throw new ValidationError("Oracle winner Option variant is invalid.");
        return createDataResult({ data: decodeSingleU256(response.data.slice(1), "oracleWinner"), source: "starknet-rpc", complete: true, attempts: response.attempts, startedAt, now: context.now, ...(context.logger ? { logger: context.logger } : {}) });
      } catch {
        throw new UnsupportedCapabilityError("oracle winner view", { network: context.network.name });
      }
    },
  };
}
