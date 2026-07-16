// Curated from the pinned Cage Calls contract interfaces.
export const CURATED_ENTRYPOINTS = Object.freeze({
  CALLS: ["balance_of", "allowance", "approve", "transfer", "transfer_from", "mint", "burn", "has_role", "grant_role", "revoke_role"],
  CageCallsOracle: ["set_winner", "set_winner_index", "get_winner", "is_admin", "grant_admin", "revoke_admin"],
  ConditionalTokens: ["balance_of", "is_approved_for_all", "get_payout_numerator", "get_payout_denominator", "split_position", "merge_position", "redeem_positions"],
  FightFactory: ["fight", "get_fight_feed", "get_fight_feed_by_ids", "get_fight_buys", "get_fight_buy", "get_fight_winner", "get_account_fight_ids", "get_account_fight_feed", "next_fight_id", "has_bought", "has_redeemed", "user_choice", "preview_strike_tickets", "fight_winner_index", "winners_count", "fight_pot_total", "fight_pot_claimed", "create_fight", "buy_fight", "close_fight", "settle_fight", "redeem", "set_collateral_token", "is_admin", "grant_admin", "revoke_admin"],
  FighterRegistry: ["get_fighter", "get_fighters", "fighter_exists", "fighter_is_active", "register_fighter", "update_fighter", "activate_fighter", "deactivate_fighter", "is_admin", "grant_admin", "revoke_admin"],
  Gacha: ["pool_open", "pool_size", "get_pool_state", "get_pool_states", "get_user_states", "get_available_token_ids", "pool_registered_count", "pool_available_count", "expected_count", "escrowed_token", "get_strike_nonce", "vrf_address", "strike", "keep", "set_pool_open", "register_relic", "unregister_relic", "reset_pool", "set_vrf_address", "is_admin", "grant_admin", "revoke_admin"],
  Markets: ["get_market", "get_market_position", "get_vault_numerator", "get_vault_denominator", "buy", "close_market", "resolve", "redeem", "register_token", "register_oracle", "pause", "unpause", "is_paused", "has_role", "grant_role", "revoke_role"],
  RelicNFT: ["owner_of", "balance_of", "relic_data", "relic_metadata", "relic_event_name", "get_token_uri", "get_relic_feed", "get_relics", "get_owned_relics", "next_token_id", "mint_relic", "update_relic_metadata", "update_token_uri", "grant_minter", "revoke_minter", "grant_curator", "revoke_curator"],
  StrikeTickets: ["balance_of", "is_approved_for_all", "set_approval_for_all"],
  VaultFees: ["balance_of", "is_approved_for_all", "set_approval_for_all"],
  VaultPositions: ["balance_of", "is_approved_for_all", "set_approval_for_all"],
} as const);
