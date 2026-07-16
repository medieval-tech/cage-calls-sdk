import { normalizeAddress } from "../core/codecs.js";
import type { EventRef } from "./aggregates.js";
import type { Address, CageCallsActivity } from "../core/types.js";

export type CageCallsLiveUpdate =
  | { kind: "activity"; activity: CageCallsActivity }
  | { kind: "fighter"; fighterId: bigint }
  | { kind: "fight"; fightId: bigint; event?: EventRef }
  | { kind: "market"; marketId: bigint; fightId?: bigint }
  | { kind: "relic"; tokenId: bigint; owner?: Address; fightId?: bigint; fighterId?: bigint }
  | { kind: "gacha"; fightId: bigint; account?: Address }
  | { kind: "token-balance"; account: Address; token: string; tokenId?: bigint }
  | { kind: "reconcile"; reason: "reconnected" };

export type LiveConnectionStatus = "connecting" | "connected" | "disconnected" | "reconnecting";

export interface CageCallsLiveSubscription {
  unsubscribe(): void | Promise<void>;
}

export interface CageCallsLiveObserver {
  update(update: CageCallsLiveUpdate): void;
  status?(status: LiveConnectionStatus): void;
  error?(error: unknown): void;
}

/**
 * Adapter boundary for Dojo/Torii subscription clients. The core SDK deliberately
 * does not import a WebSocket implementation or start a polling loop.
 */
export interface CageCallsLiveTransport {
  subscribe(observer: CageCallsLiveObserver): Promise<CageCallsLiveSubscription> | CageCallsLiveSubscription;
}

export interface LiveFilter {
  account?: Address;
  event?: EventRef;
  kinds?: readonly CageCallsLiveUpdate["kind"][];
}

export interface LiveRepository {
  readonly available: boolean;
  subscribe(filter: LiveFilter, observer: CageCallsLiveObserver): Promise<CageCallsLiveSubscription>;
}

function matches(update: CageCallsLiveUpdate, filter: LiveFilter): boolean {
  if (filter.kinds && !filter.kinds.includes(update.kind)) return false;
  if (update.kind === "reconcile") return true;
  if (filter.account) {
    const wanted = normalizeAddress(filter.account);
    const account = "account" in update && update.account ? normalizeAddress(update.account) : undefined;
    const owner = "owner" in update && update.owner ? normalizeAddress(update.owner) : undefined;
    if (account && account !== wanted && owner !== wanted) return false;
  }
  if (filter.event) {
    if (update.kind === "fight" && update.event) {
      if (update.event.seasonId !== filter.event.seasonId || update.event.eventName !== filter.event.eventName) return false;
    } else if (!("fightId" in update)) {
      return false;
    }
  }
  return true;
}

export function createLiveRepository(transport?: CageCallsLiveTransport): LiveRepository {
  return {
    available: Boolean(transport),
    async subscribe(filter, observer) {
      if (!transport) throw new Error("A CageCalls live transport is not configured.");
      let connected = false;
      let disconnectedAfterConnection = false;
      const subscription = await transport.subscribe({
        update(update) {
          if (matches(update, filter)) observer.update(update);
        },
        status(status) {
          if (status === "connected") {
            if (connected && disconnectedAfterConnection) observer.update({ kind: "reconcile", reason: "reconnected" });
            connected = true;
            disconnectedAfterConnection = false;
          } else if (connected && (status === "disconnected" || status === "reconnecting")) {
            disconnectedAfterConnection = true;
          }
          observer.status?.(status);
        },
        error(error) { observer.error?.(error); },
      });
      return subscription;
    },
  };
}
