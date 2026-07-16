import { createDataResult } from "../core/request.js";
import { normalizeAddress, normalizeFelt } from "../core/codecs.js";
import { decodeSingleBool, decodeSingleU256, scalarBoolean, scalarNumber, scalarString } from "../core/decoders.js";
import { AllSourcesFailedError, UnsupportedCapabilityError, ValidationError } from "../core/errors.js";
import type { RepositoryContext } from "./index.js";
import { readAllToriiModels } from "../transports/torii-models.js";
import { transportAttemptsFromError } from "../transports/index.js";
import type {
  Address,
  ContractName,
  DataResult,
  DataWarning,
  Felt,
  Page,
  RegisteredAsset,
  RequestOptions,
  RoleMembership,
  SourceAttempt,
} from "../core/types.js";

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
  registeredTokensAll(options?: RequestOptions): Promise<DataResult<RegisteredAsset[]>>;
  registeredOraclesAll(options?: RequestOptions): Promise<DataResult<RegisteredAsset[]>>;
  marketsPaused(options?: RequestOptions): Promise<DataResult<boolean>>;
  oracleWinner(marketId: bigint, options?: RequestOptions): Promise<DataResult<bigint | undefined>>;
}

export function createAdminRepository(context: RepositoryContext): AdminRepository {
  const rpc = async (contract: ContractName, entrypoint: string, calldata: string[], options: RequestOptions) =>
    context.rpc.call({ contractAddress: context.network.contracts[contract], entrypoint, calldata }, options);

  const assetSelection = (model: "RegisteredToken" | "RegisteredOracle") => model === "RegisteredToken"
    ? ["contract_address", "name", "symbol", "decimals"]
    : ["contract_address", "name", "description"];
  const mapAsset = (node: Record<string, unknown>): RegisteredAsset => {
    const item: RegisteredAsset = {
      contractAddress: normalizeAddress(String(node.contract_address)),
      active: true,
    };
    if (node.name !== undefined) item.name = scalarString(node.name, "name");
    if (node.symbol !== undefined) item.symbol = scalarString(node.symbol, "symbol");
    if (node.description !== undefined) item.description = scalarString(node.description, "description");
    if (node.decimals !== undefined) item.decimals = scalarNumber(node.decimals, "decimals");
    return item;
  };
  const assets = async (model: "RegisteredToken" | "RegisteredOracle", input: { limit?: number; cursor?: string }, options: RequestOptions) => {
    const startedAt = context.now();
    if (!context.torii) throw new UnsupportedCapabilityError(`${model} enumeration without Torii`);
    const response = await context.torii.model<Record<string, unknown>>({
      model,
      selection: assetSelection(model),
      first: Math.min(Math.max(input.limit ?? 50, 1), context.budget.pageSize),
      ...(input.cursor ? { after: input.cursor } : {}),
    }, options);
    const items = response.data.edges.map(({ node }) => mapAsset(node));
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
  const allAssets = async (model: "RegisteredToken" | "RegisteredOracle", options: RequestOptions) => {
    const startedAt = context.now();
    if (!context.torii) throw new UnsupportedCapabilityError(`${model} enumeration without Torii`);
    const response = await readAllToriiModels(context, {
      model,
      selection: assetSelection(model),
    }, mapAsset, options);
    return createDataResult({
      data: response.items,
      source: "torii",
      complete: response.complete,
      attempts: response.attempts,
      warnings: response.warnings,
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
      const attempts: SourceAttempt[] = [];
      const warnings: DataWarning[] = [];
      let successfulModels = 0;
      let complete = true;
      for (const [contract, model] of Object.entries(ROLE_MODELS) as Array<[keyof typeof ROLE_MODELS, string]>) {
        const addressField = model === "RelicMinter" ? "minter" : "admin";
        try {
          const response = await readAllToriiModels(context, { model, selection: [addressField, "active"] }, (node): RoleMembership => ({
            contract,
            account: normalizeAddress(String(node[addressField])),
            role: model,
            active: scalarBoolean(node.active, "active"),
          }), options);
          successfulModels += 1;
          values.push(...response.items);
          attempts.push(...response.attempts);
          warnings.push(...response.warnings);
          complete &&= response.complete;
        } catch (error) {
          complete = false;
          attempts.push(...transportAttemptsFromError(error));
          warnings.push({
            code: "TORII_ROLE_MODEL_UNAVAILABLE",
            message: `${model} role enumeration failed; other role models were retained.`,
            source: "torii" as const,
          });
        }
      }
      if (successfulModels === 0) throw new AllSourcesFailedError("admin.roles", attempts);
      return createDataResult({ data: values, source: "torii", complete, attempts, warnings, startedAt, now: context.now, ...(context.logger ? { logger: context.logger } : {}) });
    },
    registeredTokens(input = {}, options = {}) { return assets("RegisteredToken", input, options); },
    registeredOracles(input = {}, options = {}) { return assets("RegisteredOracle", input, options); },
    registeredTokensAll(options = {}) { return allAssets("RegisteredToken", options); },
    registeredOraclesAll(options = {}) { return allAssets("RegisteredOracle", options); },
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
