import type { CageCallsNetwork, ContractName } from "./types.js";

export interface ControllerMethodPolicy {
  entrypoint: string;
  spender?: string;
  amount?: string;
}

export interface ControllerSessionPolicies {
  contracts: Record<string, { methods: ControllerMethodPolicy[] }>;
}

const METHODS: Readonly<Partial<Record<ContractName, readonly string[]>>> = {
  FightFactory: ["buy_fight", "redeem", "create_fight", "close_fight", "settle_fight", "grant_admin", "revoke_admin", "set_collateral_token"],
  CageCallsOracle: ["set_winner", "set_winner_index", "grant_admin", "revoke_admin"],
  Gacha: ["strike", "keep", "set_pool_open", "register_relic", "unregister_relic", "reset_pool", "set_vrf_address", "grant_admin", "revoke_admin"],
  Markets: ["buy", "redeem", "create_market", "resolve", "close_market", "register_token", "register_oracle", "pause", "unpause"],
  RelicNFT: ["mint_relic", "update_relic_metadata", "update_token_uri", "grant_minter", "revoke_minter", "grant_curator", "revoke_curator", "grant_role", "revoke_role"],
  StrikeTickets: ["set_approval_for_all"],
  ConditionalTokens: ["redeem_positions", "split_position", "merge_position"],
  VaultPositions: ["set_approval_for_all"],
  FighterRegistry: ["register_fighter", "update_fighter", "activate_fighter", "deactivate_fighter", "grant_admin", "revoke_admin"],
};

export function createControllerChain(network: CageCallsNetwork): { rpcUrl: string } {
  return { rpcUrl: network.cartridgeRpcUrl };
}

export function createControllerSessionPolicies(network: CageCallsNetwork): ControllerSessionPolicies {
  const contracts: ControllerSessionPolicies["contracts"] = {};
  for (const [name, methods] of Object.entries(METHODS) as Array<[ContractName, readonly string[]]>) {
    contracts[network.contracts[name]] = { methods: methods.map((entrypoint) => ({ entrypoint })) };
  }
  contracts[network.contracts.CALLS] = {
    methods: [{
      entrypoint: "approve",
      spender: network.contracts.Markets,
      amount: "0xffffffffffffffffffffffffffffffff",
    }],
  };
  contracts[network.vrfAddress] = { methods: [{ entrypoint: "request_random" }] };
  return { contracts };
}
