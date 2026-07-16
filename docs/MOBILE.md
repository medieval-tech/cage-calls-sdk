# Mobile integration

The framework-neutral entry point is suitable for React Native services, Capacitor applications,
and other JavaScript mobile runtimes that provide `fetch`, `URL`, `AbortController`, and `BigInt`.
The repository includes a Capacitor build fixture that is validated in CI.

## Recommended setup

Create one client for the selected deployment and keep it for the application session:

```ts
import {
  SEPOLIA_DEV_PRESET,
  createCageCallsClient,
  createFallbackRpcTransport,
  createToriiGraphqlTransport,
} from "@medieval-tech/cage-calls-sdk";

const reads = createCageCallsClient({
  network: "sepolia-dev",
  transports: {
    torii: createToriiGraphqlTransport({ url: SEPOLIA_DEV_PRESET.toriiUrl }),
    rpc: createFallbackRpcTransport({
      primaryUrl: mobileConfig.starknetRpcUrl,
      fallbackUrl: SEPOLIA_DEV_PRESET.cartridgeRpcUrl,
    }),
  },
});
```

Inject authenticated RPC URLs through the application's secure runtime configuration. Do not
embed provider secrets in the package, source bundle, logs, or checked-in environment files.

## Lifecycle and caching

The core client does not retain completed-result caches, so it is safe to keep across background
and foreground transitions. The application should own screen caching, retry UI, offline policy,
and refresh triggers. Inspect `DataResult.meta.complete` and warnings before presenting a result as
authoritative.

React Native consumers can use the framework-neutral client with their preferred query library.
Capacitor/React webviews may use `@medieval-tech/cage-calls-sdk/react` with React Query.

## Product journey mapping

The SDK owns onchain reads, not editorial content or screen models:

| Journey | Application source | SDK read |
| --- | --- | --- |
| Latest and event presentation | Existing REST service | Optional onchain enrichment |
| Event prediction | REST fight IDs | `fightEvents.get(name, { seasonId, fightIds, viewer })` |
| Claim and account actions | Connected account | `accounts.fightStates(account, { limit, cursor })` |
| Gacha overview | Relevant fight IDs | `gacha.poolStates(ids)` and `gacha.userStates(ids, account)` |
| Owned relics | Connected account | `relics.ownedInventory(account)` |
| Relic detail | Selected token | `relics.get(tokenId)` then lazy `relics.metadata(tokenId)` |
| Fighter bios, media, blogs, notifications | Existing REST/static data | No SDK replacement |

Do not load `accounts.portfolio`, `fightEvents.all`, or external metadata before showing an
interactive screen. Page historical account state after the first result and hydrate media only
for visible relic cards or a selected detail.

```ts
const event = await reads.fightEvents.get(event.name, {
  seasonId: event.seasonId,
  fightIds: event.fights.map((fight) => BigInt(fight.onchainId)),
  viewer: account,
});

const claims = await reads.accounts.fightStates(account, { limit: 20 });
// claims.data.actions contains eligibility, not executable wallet calls.
```

When `meta.complete` is false, retain valid rows, expose a refresh/degraded indicator, and avoid
claiming that an empty partial result proves there are no actions. `CAPABILITY_FALLBACK` means the
selected deployment lacks a newer batch view; it is distinct from total RPC failure.

## Transactions

The SDK does not replace Cartridge Controller or the application's transaction layer. Mobile code
must continue to own:

- account connection and chain selection;
- session policies and paymaster configuration;
- calldata construction and transaction execution;
- receipt monitoring and user-facing transaction errors;
- invalidating or refetching reads after a successful transaction.

This separation allows the read client to degrade from Torii to RPC without coupling reliability
to a particular wallet implementation.

## Post-transaction invalidation

Keep transaction execution in Cartridge, then invalidate the concrete query keys used by the
current journey:

- predict: event/fight feed and account fight-state keys;
- redeem payout: fight feed, account fight-state, and CALLS balance keys;
- strike: Gacha user/pool and account fight-state keys;
- keep or claim relic: Gacha user/pool, account fight-state, and owned-relic keys.

When a screen uses several parameterized feed keys, invalidating `cageCallsQueryKeys.all()` is a
safe coarse fallback. The SDK never polls or invalidates transaction state by itself.

## Torii outage expectations

- Prediction with at most 20 backend-known fight IDs uses one FightFactory batch after the
  `fightFeedByIds` contract upgrade.
- An account page uses one account fight-feed call plus at most one Gacha user-state batch.
- Owned relics use indexed ownership first and paged ERC721 RPC recovery when indexing fails.
- Deployments without a batch capability remain compatible but return explicit degraded metadata
  and may require more bounded RPC calls.

## Integration checklist

1. Select a built-in preset or pass a complete custom `CageCallsNetwork`.
2. Configure Torii plus a dedicated Starknet RPC and Cartridge fallback.
3. Surface incomplete reads and warnings in diagnostics.
4. Fetch display metadata only for visible relics; use inventory reads for counts and analytics.
5. Test Node/SSR-equivalent startup and the target native/webview runtime before release.
