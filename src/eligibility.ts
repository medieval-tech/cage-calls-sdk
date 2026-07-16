import type {
  ActionEligibility,
  FightActionEligibility,
  FightActionEligibilityInput,
  GachaActionEligibility,
  GachaActionEligibilityInput,
} from "./core/types.js";

const allow = (): ActionEligibility => ({ allowed: true });
const deny = (reason: string): ActionEligibility => ({ allowed: false, reason });

export function deriveFightActionEligibility(input: FightActionEligibilityInput): FightActionEligibility {
  const { fight } = input;
  const now = input.now ?? BigInt(Math.floor(Date.now() / 1_000));
  const verified = input.stateComplete !== false;

  const buy = !input.connected
    ? deny("Connect a wallet to bid.")
    : !fight
      ? deny("Fight state is unavailable.")
      : !verified
        ? deny("The current fight state could not be verified.")
        : fight.viewer.hasBought
          ? deny("This wallet has already bid on the fight.")
          : fight.pot.closed || fight.pot.settled || fight.resolvedAt > 0n
            ? deny("Bidding is closed.")
            : now < fight.startAt
              ? deny("Bidding has not opened yet.")
              : now >= fight.endAt
                ? deny("The bidding window has ended.")
                : allow();

  const redeem = !input.connected
    ? deny("Connect a wallet to redeem.")
    : !fight
      ? deny("Fight state is unavailable.")
      : !verified
        ? deny("Redemption state could not be verified.")
        : !fight.viewer.hasBought
          ? deny("This wallet has no position in the fight.")
          : fight.viewer.hasRedeemed
            ? deny("This position has already been redeemed.")
            : !fight.pot.settled
              ? deny("The fight must be settled before redemption.")
              : allow();

  const close = !input.fightFactoryAdmin
    ? deny("FightFactory admin permission is required.")
    : !fight
      ? deny("Fight state is unavailable.")
      : !verified
        ? deny("The current fight state could not be verified.")
        : fight.pot.closed || fight.pot.settled || fight.resolvedAt > 0n
          ? deny("The fight is already closed.")
          : allow();

  const settle = !input.oracleAdmin
    ? deny("Oracle admin permission is required.")
    : !fight
      ? deny("Fight state is unavailable.")
      : !verified
        ? deny("Settlement state could not be verified.")
        : fight.pot.settled || fight.resolvedAt > 0n
          ? deny("The fight is already settled.")
          : now < fight.resolveAt
            ? deny("The fight is not resolvable yet.")
            : input.oracleWinnerSet !== true
              ? deny("Set and verify the oracle winner before settling.")
              : allow();

  return { buy, redeem, close, settle };
}

export function deriveGachaActionEligibility(input: GachaActionEligibilityInput): GachaActionEligibility {
  const { pool, user } = input;
  const verified = input.stateComplete !== false;
  const escrowed = user?.escrowedTokenId !== undefined && user.escrowedTokenId > 0n;
  const expected = pool?.rarities.reduce((total, rarity) => total + rarity.expected, 0n) ?? 0n;
  const completePool = Boolean(pool)
    && pool!.size > 0n
    && pool!.size >= expected
    && pool!.rarities.every((rarity) => rarity.registered >= rarity.expected);

  const strike = !input.connected
    ? deny("Connect a wallet to strike.")
    : !pool || !user
      ? deny("Pool or ticket state is unavailable.")
      : !verified
        ? deny("Pool and ticket state could not be verified.")
        : !pool.open
          ? deny("The pool is closed.")
          : user.ticketBalance <= 0n
            ? deny("This wallet has no StrikeTickets for the fight.")
            : pool.size <= 0n && !escrowed
              ? deny("The pool is empty.")
              : allow();

  const keep = !input.connected
    ? deny("Connect a wallet to keep a relic.")
    : !user
      ? deny("Escrow state is unavailable.")
      : !verified
        ? deny("Escrow state could not be verified.")
        : !escrowed
          ? deny("There is no relic in escrow.")
          : allow();

  const openPool = !input.gachaAdmin
    ? deny("Gacha admin permission is required.")
    : !pool
      ? deny("Pool state is unavailable.")
      : !verified
        ? deny("Pool readiness could not be verified.")
        : pool.open
          ? deny("The pool is already open.")
          : pool.size <= 0n
            ? deny("The pool is empty.")
            : !completePool
              ? deny("The pool is incomplete.")
              : allow();

  const closePool = !input.gachaAdmin
    ? deny("Gacha admin permission is required.")
    : !pool
      ? deny("Pool state is unavailable.")
      : !verified
        ? deny("Pool state could not be verified.")
        : !pool.open
          ? deny("The pool is already closed.")
          : allow();

  return { strike, keep, openPool, closePool };
}
