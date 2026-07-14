import { encodeByteArray, encodeShortString, encodeU256, normalizeAddress, normalizeFelt } from "./codecs.js";
import { ValidationError } from "./errors.js";
import { cageCallsQueryKeys as keys } from "./queryKeys.js";
import type {
  Address,
  CageCallsNetwork,
  CallPlan,
  ContractName,
  Felt,
  RelicMetadata,
  StarknetCall,
} from "./types.js";

function call(contractAddress: Address, entrypoint: string, calldata: string[] = []): StarknetCall {
  return { contractAddress, entrypoint, calldata };
}

function plan(calls: StarknetCall[], invalidate: CallPlan["invalidate"], requirements?: CallPlan["requirements"]): CallPlan {
  return { calls, invalidate, ...(requirements ? { requirements } : {}) };
}

function bool(value: boolean): string {
  return value ? "1" : "0";
}

function array<T>(values: readonly T[], encode: (value: T) => string[]): string[] {
  return [values.length.toString(), ...values.flatMap((value) => encode(value))];
}

function encodeRelicMetadata(metadata: RelicMetadata): string[] {
  return [
    ...encodeU256(metadata.definitionId),
    ...encodeU256(metadata.seasonId),
    ...encodeU256(metadata.fightId),
    ...encodeU256(metadata.fighterId),
    ...encodeU256(metadata.opponentId),
    encodeShortString(metadata.sponsor),
    metadata.relicIndex.toString(),
    metadata.fightTimestamp.toString(),
    encodeShortString(metadata.mediaUri),
    metadata.mediaType.toString(),
    metadata.category.toString(),
    encodeShortString(metadata.moveType),
    encodeShortString(metadata.moveName),
    ...encodeU256(metadata.tags),
    metadata.intent.toString(),
    metadata.effectVector.toString(),
    metadata.targetZone.toString(),
    metadata.power.toString(),
    metadata.speed.toString(),
    metadata.control.toString(),
    metadata.risk.toString(),
    metadata.complexity.toString(),
    metadata.versatility.toString(),
    metadata.comboFlags.toString(),
    ...encodeU256(metadata.linkableToTags),
    ...encodeU256(metadata.requiresTagsBefore),
    metadata.rarity.toString(),
    encodeShortString(metadata.relicType),
    encodeShortString(metadata.style),
    encodeShortString(metadata.weightClass),
  ];
}

export interface MarketCreateInput {
  oracle?: Address;
  collateralToken?: Address;
  initialRepartition: readonly number[];
  fundingAmount: bigint;
  feeCurve?: { start: number; end: number };
  feeShareCurve?: { start: number; end: number };
  oracleParams?: readonly Felt[];
  oracleExtraParams?: readonly Felt[];
  outcomeValues: readonly bigint[];
  startAt: bigint;
  endAt: bigint;
  resolveAt: bigint;
  title?: string;
  terms?: string;
  creatorFee?: number;
}

export interface FightCreateInput {
  seasonId: bigint;
  eventName: string;
  fighterAId: bigint;
  fighterBId: bigint;
  choiceALabel: string;
  choiceBLabel: string;
  choiceAValue?: bigint;
  choiceBValue?: bigint;
  market: MarketCreateInput;
  isDev?: boolean;
  sponsor?: string;
}

function assertU32(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffff_ffff) throw new ValidationError(`${label} must be a u32.`);
}

function encodeMarketCreate(input: MarketCreateInput, network: CageCallsNetwork): string[] {
  if (input.outcomeValues.length < 2) throw new ValidationError("A categorical market requires at least two outcome values.");
  if (input.initialRepartition.length !== input.outcomeValues.length + 1) {
    throw new ValidationError("initialRepartition must include one value per outcome plus the fallback outcome.");
  }
  if (!(input.startAt < input.endAt && input.endAt < input.resolveAt)) {
    throw new ValidationError("Market lifecycle must satisfy startAt < endAt < resolveAt.");
  }
  input.initialRepartition.forEach((value, index) => assertU32(value, `initialRepartition[${index}]`));
  const fee = input.feeCurve ?? { start: 0, end: 0 };
  const feeShare = input.feeShareCurve ?? { start: 0, end: 0 };
  assertU32(fee.start, "feeCurve.start");
  assertU32(fee.end, "feeCurve.end");
  assertU32(feeShare.start, "feeShareCurve.start");
  assertU32(feeShare.end, "feeShareCurve.end");
  const creatorFee = input.creatorFee ?? 0;
  assertU32(creatorFee, "creatorFee");

  return [
    normalizeAddress(input.oracle ?? network.contracts.CageCallsOracle),
    normalizeAddress(input.collateralToken ?? network.contracts.CALLS),
    "0", // MarketModel::Vault
    input.initialRepartition.length.toString(),
    ...input.initialRepartition.map(String),
    ...encodeU256(input.fundingAmount),
    "0", fee.start.toString(), fee.end.toString(), // Curve::Linear
    "0", feeShare.start.toString(), feeShare.end.toString(),
    ...(input.oracleParams ? array(input.oracleParams, (value) => [normalizeFelt(value)]) : ["0"]),
    ...(input.oracleExtraParams ? array(input.oracleExtraParams, (value) => [normalizeFelt(value)]) : ["0"]),
    "0", // OracleValueType::u256
    "1", // MarketType::Categorical
    "0", // MarketTypeCategorical::ValueEq
    ...array(input.outcomeValues, encodeU256),
    input.startAt.toString(),
    input.endAt.toString(),
    input.resolveAt.toString(),
    ...encodeByteArray(input.title ?? ""),
    ...encodeByteArray(input.terms ?? ""),
    creatorFee.toString(),
  ];
}

export interface CageCallsCallBuilders {
  fighters: {
    register(fighterId: bigint, name: string, weightClass: string): CallPlan;
    update(fighterId: bigint, name: string, weightClass: string): CallPlan;
    activate(fighterId: bigint): CallPlan;
    deactivate(fighterId: bigint): CallPlan;
    grantAdmin(account: Address): CallPlan;
    revokeAdmin(account: Address): CallPlan;
  };
  fights: {
    create(input: FightCreateInput): CallPlan;
    buy(fightId: bigint, choiceValue: bigint): CallPlan;
    close(fightId: bigint): CallPlan;
    settle(fightId: bigint): CallPlan;
    redeem(fightId: bigint): CallPlan;
    setCollateral(token: Address): CallPlan;
    setWinnerAndSettle(fightId: bigint, marketId: bigint, winnerIndex: number): CallPlan;
  };
  markets: {
    create(input: MarketCreateInput): CallPlan;
    approveCollateral(amount: bigint, token?: Address): CallPlan;
    buy(marketId: bigint, outcomeIndex: number, amount: bigint, input?: { approve?: boolean; token?: Address }): CallPlan;
    close(marketId: bigint): CallPlan;
    resolve(marketId: bigint): CallPlan;
    redeem(marketId: bigint, positionIds: readonly bigint[]): CallPlan;
    redeemPositions(input: { marketId: bigint; positionIds: readonly bigint[]; collateralToken: Address; conditionId: bigint; outcomeSlotCount: number }): CallPlan;
  };
  relics: {
    mint(recipient: Address, metadata: RelicMetadata, eventName: string, editionNumber: bigint, tokenUri: string): CallPlan;
    updateMetadata(tokenId: bigint, metadata: RelicMetadata, eventName: string): CallPlan;
    updateTokenUri(tokenId: bigint, tokenUri: string): CallPlan;
    grantMinter(account: Address): CallPlan;
    revokeMinter(account: Address): CallPlan;
    grantCurator(account: Address): CallPlan;
    revokeCurator(account: Address): CallPlan;
  };
  gacha: {
    strike(fightId: bigint, vrfSeed: Felt): CallPlan;
    keep(fightId: bigint, owner?: Address): CallPlan;
    setOpen(fightId: bigint, open: boolean): CallPlan;
    registerRelic(fightId: bigint, tokenId: bigint): CallPlan;
    unregisterRelic(fightId: bigint, tokenId: bigint): CallPlan;
    reset(fightId: bigint): CallPlan;
    setVrf(address: Address): CallPlan;
    grantAdmin(account: Address): CallPlan;
    revokeAdmin(account: Address): CallPlan;
  };
  oracle: {
    setWinner(marketId: bigint, winner: bigint): CallPlan;
    setWinnerIndex(marketId: bigint, winnerIndex: number): CallPlan;
    grantAdmin(account: Address): CallPlan;
    revokeAdmin(account: Address): CallPlan;
  };
  admin: {
    registerToken(token: Address): CallPlan;
    registerOracle(oracle: Address): CallPlan;
    pauseMarkets(): CallPlan;
    unpauseMarkets(): CallPlan;
    grantRole(contract: ContractName, role: Felt, account: Address): CallPlan;
    revokeRole(contract: ContractName, role: Felt, account: Address): CallPlan;
    batch(plans: readonly CallPlan[]): CallPlan;
  };
}

function singleAdmin(network: CageCallsNetwork, contract: "FighterRegistry" | "Gacha" | "CageCallsOracle", entrypoint: "grant_admin" | "revoke_admin", account: Address): CallPlan {
  return plan([call(network.contracts[contract], entrypoint, [normalizeAddress(account)])], [keys.admin()]);
}

export function createCallBuilders(network: Readonly<CageCallsNetwork>): CageCallsCallBuilders {
  const idCall = (contract: ContractName, entrypoint: string, id: bigint) => call(network.contracts[contract], entrypoint, encodeU256(id));
  const markets = network.contracts.Markets;
  const gacha = network.contracts.Gacha;

  const builders: CageCallsCallBuilders = {
    fighters: {
      register(fighterId, name, weightClass) {
        return plan([call(network.contracts.FighterRegistry, "register_fighter", [...encodeU256(fighterId), ...encodeByteArray(name), ...encodeByteArray(weightClass)])], [keys.fighters(), keys.fighter(fighterId), keys.activity()]);
      },
      update(fighterId, name, weightClass) {
        return plan([call(network.contracts.FighterRegistry, "update_fighter", [...encodeU256(fighterId), ...encodeByteArray(name), ...encodeByteArray(weightClass)])], [keys.fighters(), keys.fighter(fighterId), keys.activity()]);
      },
      activate(fighterId) { return plan([idCall("FighterRegistry", "activate_fighter", fighterId)], [keys.fighters(), keys.fighter(fighterId), keys.activity()]); },
      deactivate(fighterId) { return plan([idCall("FighterRegistry", "deactivate_fighter", fighterId)], [keys.fighters(), keys.fighter(fighterId), keys.activity()]); },
      grantAdmin(account) { return singleAdmin(network, "FighterRegistry", "grant_admin", account); },
      revokeAdmin(account) { return singleAdmin(network, "FighterRegistry", "revoke_admin", account); },
    },
    fights: {
      create(input) {
        if (input.fighterAId === input.fighterBId) throw new ValidationError("Fight fighters must be different.");
        const choiceAValue = input.choiceAValue ?? input.fighterAId;
        const choiceBValue = input.choiceBValue ?? input.fighterBId;
        const calldata = [
          ...encodeU256(input.seasonId),
          ...encodeByteArray(input.eventName),
          ...encodeU256(input.fighterAId),
          ...encodeU256(input.fighterBId),
          ...encodeByteArray(input.choiceALabel),
          ...encodeByteArray(input.choiceBLabel),
          ...encodeU256(choiceAValue),
          ...encodeU256(choiceBValue),
          ...encodeMarketCreate(input.market, network),
          bool(input.isDev ?? false),
          encodeShortString(input.sponsor ?? ""),
        ];
        return plan([call(network.contracts.FightFactory, "create_fight", calldata)], [keys.fights(), keys.fightEvents(), keys.markets(), keys.activity()], { controller: true });
      },
      buy(fightId, choiceValue) {
        return plan([call(network.contracts.FightFactory, "buy_fight", [...encodeU256(fightId), ...encodeU256(choiceValue)])], [keys.fight(fightId), keys.fightBuys(fightId), keys.markets(), keys.activity()], { controller: true });
      },
      close(fightId) { return plan([idCall("FightFactory", "close_fight", fightId)], [keys.fight(fightId), keys.fights(), keys.fightEvents(), keys.markets()]); },
      settle(fightId) { return plan([idCall("FightFactory", "settle_fight", fightId)], [keys.fight(fightId), keys.fights(), keys.fightEvents(), keys.markets(), keys.activity()]); },
      redeem(fightId) { return plan([idCall("FightFactory", "redeem", fightId)], [keys.fight(fightId), keys.fightBuys(fightId), keys.tokens(), keys.activity()]); },
      setCollateral(token) { return plan([call(network.contracts.FightFactory, "set_collateral_token", [normalizeAddress(token)])], [keys.admin()]); },
      setWinnerAndSettle(fightId, marketId, winnerIndex) {
        if (!Number.isSafeInteger(winnerIndex) || winnerIndex < 0 || winnerIndex > 255) throw new ValidationError("winnerIndex must be a u8.");
        return plan([
          call(network.contracts.CageCallsOracle, "set_winner_index", [...encodeU256(marketId), winnerIndex.toString()]),
          idCall("FightFactory", "settle_fight", fightId),
        ], [keys.fight(fightId), keys.market(marketId), keys.fights(), keys.markets(), keys.activity()]);
      },
    },
    markets: {
      create(input) { return plan([call(markets, "create_market", encodeMarketCreate(input, network))], [keys.markets(), keys.activity()]); },
      approveCollateral(amount, token = network.contracts.CALLS) {
        return plan([call(token, "approve", [markets, ...encodeU256(amount)])], [keys.tokens()], { tokenApproval: true, controller: true });
      },
      buy(marketId, outcomeIndex, amount, input = {}) {
        if (!Number.isSafeInteger(outcomeIndex) || outcomeIndex < 0 || outcomeIndex > 255) throw new ValidationError("outcomeIndex must be a u8.");
        const calls = [call(markets, "buy", [...encodeU256(marketId), outcomeIndex.toString(), ...encodeU256(amount)])];
        if (input.approve ?? true) calls.unshift(call(input.token ?? network.contracts.CALLS, "approve", [markets, ...encodeU256(amount)]));
        return plan(calls, [keys.market(marketId), keys.markets(), keys.tokens(), keys.activity()], { controller: true, tokenApproval: input.approve ?? true });
      },
      close(marketId) { return plan([idCall("Markets", "close_market", marketId)], [keys.market(marketId), keys.markets(), keys.activity()]); },
      resolve(marketId) { return plan([idCall("Markets", "resolve", marketId)], [keys.market(marketId), keys.markets(), keys.activity()]); },
      redeem(marketId, positionIds) {
        return plan([call(markets, "redeem", [...encodeU256(marketId), ...array(positionIds, encodeU256)])], [keys.market(marketId), keys.markets(), keys.tokens(), keys.activity()]);
      },
      redeemPositions(input) {
        if (!Number.isSafeInteger(input.outcomeSlotCount) || input.outcomeSlotCount < 2 || input.outcomeSlotCount > 255) throw new ValidationError("outcomeSlotCount must be between 2 and 255.");
        const indexSets = Array.from({ length: input.outcomeSlotCount }, (_, index) => 1n << BigInt(index));
        return plan([
          call(network.contracts.VaultPositions, "set_approval_for_all", [markets, "1"]),
          call(markets, "redeem", [...encodeU256(input.marketId), ...array(input.positionIds, encodeU256)]),
          call(network.contracts.ConditionalTokens, "redeem_positions", [
            normalizeAddress(input.collateralToken), ...encodeU256(0n), ...encodeU256(input.conditionId), ...array(indexSets, encodeU256),
          ]),
        ], [keys.market(input.marketId), keys.markets(), keys.tokens(), keys.activity()], { controller: true, tokenApproval: true });
      },
    },
    relics: {
      mint(recipient, metadata, eventName, editionNumber, tokenUri) {
        return plan([call(network.contracts.RelicNFT, "mint_relic", [
          normalizeAddress(recipient), ...encodeRelicMetadata(metadata), ...encodeByteArray(eventName), ...encodeU256(editionNumber), ...encodeByteArray(tokenUri),
        ])], [keys.relics(), keys.gacha(metadata.fightId), keys.activity()]);
      },
      updateMetadata(tokenId, metadata, eventName) {
        return plan([call(network.contracts.RelicNFT, "update_relic_metadata", [...encodeU256(tokenId), ...encodeRelicMetadata(metadata), ...encodeByteArray(eventName)])], [keys.relic(tokenId), keys.relics(), keys.activity()]);
      },
      updateTokenUri(tokenId, tokenUri) {
        return plan([call(network.contracts.RelicNFT, "update_token_uri", [...encodeU256(tokenId), ...encodeByteArray(tokenUri)])], [keys.relic(tokenId), keys.relics(), keys.activity()]);
      },
      grantMinter(account) { return plan([call(network.contracts.RelicNFT, "grant_minter", [normalizeAddress(account)])], [keys.admin()]); },
      revokeMinter(account) { return plan([call(network.contracts.RelicNFT, "revoke_minter", [normalizeAddress(account)])], [keys.admin()]); },
      grantCurator(account) { return plan([call(network.contracts.RelicNFT, "grant_curator", [normalizeAddress(account)])], [keys.admin()]); },
      revokeCurator(account) { return plan([call(network.contracts.RelicNFT, "revoke_curator", [normalizeAddress(account)])], [keys.admin()]); },
    },
    gacha: {
      strike(fightId, vrfSeed) {
        return plan([
          call(network.vrfAddress, "request_random", [gacha, "1", normalizeFelt(vrfSeed)]),
          call(network.contracts.StrikeTickets, "set_approval_for_all", [gacha, "1"]),
          idCall("Gacha", "strike", fightId),
        ], [keys.gacha(fightId), keys.relics(), keys.tokens(), keys.activity()], { controller: true, vrf: true, tokenApproval: true });
      },
      keep(fightId, owner) {
        return plan([idCall("Gacha", "keep", fightId)], [keys.gacha(fightId), keys.relics(), ...(owner ? [keys.ownedRelics(owner)] : []), keys.tokens(), keys.activity()], { controller: true });
      },
      setOpen(fightId, open) { return plan([call(gacha, "set_pool_open", [...encodeU256(fightId), bool(open)])], [keys.gacha(fightId), keys.admin()]); },
      registerRelic(fightId, tokenId) { return plan([call(gacha, "register_relic", [...encodeU256(fightId), ...encodeU256(tokenId)])], [keys.gacha(fightId), keys.relic(tokenId), keys.relics()]); },
      unregisterRelic(fightId, tokenId) { return plan([call(gacha, "unregister_relic", [...encodeU256(fightId), ...encodeU256(tokenId)])], [keys.gacha(fightId), keys.relic(tokenId), keys.relics()]); },
      reset(fightId) { return plan([idCall("Gacha", "reset_pool", fightId)], [keys.gacha(fightId), keys.relics()]); },
      setVrf(address) { return plan([call(gacha, "set_vrf_address", [normalizeAddress(address)])], [keys.admin()]); },
      grantAdmin(account) { return singleAdmin(network, "Gacha", "grant_admin", account); },
      revokeAdmin(account) { return singleAdmin(network, "Gacha", "revoke_admin", account); },
    },
    oracle: {
      setWinner(marketId, winner) { return plan([call(network.contracts.CageCallsOracle, "set_winner", [...encodeU256(marketId), ...encodeU256(winner)])], [keys.market(marketId), keys.activity()]); },
      setWinnerIndex(marketId, winnerIndex) {
        if (!Number.isSafeInteger(winnerIndex) || winnerIndex < 0 || winnerIndex > 255) throw new ValidationError("winnerIndex must be a u8.");
        return plan([call(network.contracts.CageCallsOracle, "set_winner_index", [...encodeU256(marketId), winnerIndex.toString()])], [keys.market(marketId), keys.activity()]);
      },
      grantAdmin(account) { return singleAdmin(network, "CageCallsOracle", "grant_admin", account); },
      revokeAdmin(account) { return singleAdmin(network, "CageCallsOracle", "revoke_admin", account); },
    },
    admin: {
      registerToken(token) { return plan([call(markets, "register_token", [normalizeAddress(token)])], [keys.admin(), keys.markets()]); },
      registerOracle(oracle) { return plan([call(markets, "register_oracle", [normalizeAddress(oracle)])], [keys.admin(), keys.markets()]); },
      pauseMarkets() { return plan([call(markets, "pause")], [keys.admin(), keys.markets()]); },
      unpauseMarkets() { return plan([call(markets, "unpause")], [keys.admin(), keys.markets()]); },
      grantRole(contract, role, account) { return plan([call(network.contracts[contract], "grant_role", [normalizeFelt(role), normalizeAddress(account)])], [keys.admin()]); },
      revokeRole(contract, role, account) { return plan([call(network.contracts[contract], "revoke_role", [normalizeFelt(role), normalizeAddress(account)])], [keys.admin()]); },
      batch(plans) {
        return plan(plans.flatMap((value) => value.calls), Array.from(new Map(plans.flatMap((value) => value.invalidate).map((value) => [JSON.stringify(value), value])).values()), {
          controller: plans.some((value) => value.requirements?.controller),
          vrf: plans.some((value) => value.requirements?.vrf),
          tokenApproval: plans.some((value) => value.requirements?.tokenApproval),
        });
      },
    },
  };
  return builders;
}
