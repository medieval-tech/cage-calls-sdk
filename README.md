# Cage Calls SDK

Framework-neutral TypeScript access to Cage Calls deployments. The core package owns reads,
decoding, source fallbacks, validation, aggregation, and typed live-update boundaries. It never
owns a wallet, constructs a transaction, signs a transaction, or waits for a receipt.

> Status: `0.2.0-next.1`. The API and deployment presets are canary-grade until the production
> client migration and network smoke tests are complete.

## Install

```sh
pnpm add @medieval-tech/cage-calls-sdk
```

React Query support is optional:

```sh
pnpm add @medieval-tech/cage-calls-sdk @tanstack/react-query react
```

Node 18+, browsers, modern edge runtimes, and Capacitor must provide `fetch`, `URL`,
`AbortController`, and `BigInt`. A custom `fetch` implementation can be passed to every HTTP
transport.

## Core quick start

```ts
import {
  MAINNET_PRESET,
  createCageCallsClient,
  createFallbackRpcTransport,
  createIpfsMetadataTransport,
  createToriiGraphqlTransport,
} from "@medieval-tech/cage-calls-sdk";

const client = createCageCallsClient({
  network: "mainnet",
  transports: {
    rpc: createFallbackRpcTransport({
      primaryUrl: process.env.ALCHEMY_RPC_URL,
      fallbackUrl: MAINNET_PRESET.cartridgeRpcUrl,
    }),
    torii: createToriiGraphqlTransport({ url: MAINNET_PRESET.toriiUrl }),
    metadata: createIpfsMetadataTransport({
      gateways: ["https://gateway.pinata.cloud/ipfs/"],
    }),
  },
});

const fights = await client.fightEvents.page({ limit: 20 });
console.log(fights.data, fights.meta);
```

`DataResult.meta` records the selected source, all attempts, completeness, warnings, timing,
and the block number when available. Partial but valid data resolves with `complete: false`;
invalid input, configuration errors, and total source failure throw typed SDK errors.

## Source policy and exhaustive reads

Indexed catalogs and analytics read Torii first. Starknet RPC verifies authoritative state and
reconstructs missing or incomplete indexed pages when the deployment exposes the additive batch
and pagination views. The configured primary RPC (for example Alchemy) is tried before the
Cartridge RPC transport fallback. Cartridge is therefore RPC failover, not a separate index.
IPFS gateways are used only for optional external NFT metadata hydration.

Identical concurrent reads are coalesced while they are in flight. Completed results are never
cached by the core SDK. Each source has a passive circuit breaker driven only by transient request
failures (rate limits, timeouts, network errors, and server errors); the SDK never sends background
health probes. Inspect `client.sources.snapshot()` or subscribe to `client.sources` to expose the
current RPC, Torii, and metadata source state in application diagnostics.

Default traversal budgets allow up to 100,000 Torii items (1,000 pages) and 100,000 RPC items
(500 pages). They are safety ceilings rather than result limits: a read that reaches one returns
the valid rows it found with `complete: false`, an exact warning, and a continuation cursor where
the repository supports one. Configure shared defaults on the client or override them per call:

```ts
const client = createCageCallsClient({
  network: "mainnet",
  transports,
  budget: {
    maxToriiItems: 200_000,
    maxToriiPages: 2_000,
    maxRpcItems: 200_000,
    maxRpcPages: 1_000,
    relicBatchSize: 100,
  },
});

const snapshot = await client.analytics.snapshot({
  traversal: { maxToriiItems: 250_000, maxRpcItems: 250_000 },
});

const relics = await client.relics.inventory({}, { relicBatchSize: 250 });
```

Contract-defined page sizes are still respected. Explicit relic ID batches default to 100 IDs,
honor the deployment's advertised limit, and split adaptively when an RPC provider cannot return
the requested response size. A `relicBatchSize` client budget or per-request override controls the
preferred size; it is not a result cap. Repositories stop early only when the source proves
exhaustion or an authoritative count/balance has been satisfied.

## Read-only domain client

The client exposes `fighters`, `fights`, `fightEvents`, `events`, `accounts`, `markets`,
`relics`, `gacha`, `tokens`, `activity`, `analytics`, and `admin` repositories. Every collection
repository provides explicit `page()` and exhaustive `all()` reads where the protocol can prove
exhaustion. Transaction encoding, signing, Controller policy, receipt handling, and cache
invalidation belong to the consuming application.

## React Query

```tsx
import { QueryClientProvider } from "@tanstack/react-query";
import {
  CageCallsProvider,
  useFightEvents,
} from "@medieval-tech/cage-calls-sdk/react";

function Events() {
  const query = useFightEvents({ limit: 20 });
  return <pre>{JSON.stringify(query.data?.data, null, 2)}</pre>;
}

// Nest CageCallsProvider below your QueryClientProvider.
```

Hooks do not poll on window focus by default. `useCageCallsLive()` consumes an optional typed
Torii subscription adapter and invalidates affected React Query keys. After a reconnect it emits
one reconciliation invalidation; it never starts a polling loop.

## Custom networks and Katana

Pass a complete `CageCallsNetwork` object instead of a preset. Validation requires chain ID,
world address, every contract address and class hash, Torii URL, Cartridge fallback URL, VRF
address, deployment revision, and capability flags. The validated result is immutable, so local
Katana deployments work without changing package globals or waiting for a release.

## Relic ownership and optional IPFS metadata

Relic ownership is verified against the onchain balance. Complete Torii results are accepted;
otherwise the repository uses bounded owner-filtered contract views over Starknet RPC.
`createIpfsMetadataTransport` tries configured gateways in order and hydrates only incomplete
metadata. Full authenticated RPC URLs are excluded from logs and errors.

Relic feeds query Torii first and fall back to the aggregate contract view only when Torii is
empty or unavailable. Complete indexed rows are returned as-is. Use `inventory()` and
`ownedInventory()` for analytics, exports, and counts: they fill missing indexed rows with
structured aggregate RPC and never request external token JSON or media. Use `collection()` and
`owned()` for display surfaces: IPFS hydration is automatic and selective for incomplete rows.
Callers do not select a metadata source:

```ts
const analyticsInventory = await client.relics.inventory({ pageSize: 200 });
const displayCollection = await client.relics.collection({ pageSize: 200 });
const visible = displayCollection.data.items.slice(0, 20);
```

For collection-wide analysis, `relics.collection()` traverses every indexed page without an
arbitrary 1,000-token cutoff and enriches fighters from Torii. `relics.stats()` adds ready-made minted-edition and
unique-definition views, while the pure helpers keep custom dashboards and export scripts free
to recompute or extend the same data:

```ts
import {
  filterRelicCollection,
  summarizeRelicCollection,
} from "@medieval-tech/cage-calls-sdk";

const collection = await client.relics.inventory();
const filter = { fighterKeys: ["jordan_rank"], rarityTiers: ["common"] as const };
const summary = summarizeRelicCollection(
  collection.data.items,
  filter,
  collection.data.fighters,
);
const matchingTokens = filterRelicCollection(collection.data.items, filter, collection.data.fighters);

console.log(summary.minted.byMoveType);
console.log(summary.definitions.byRarityLevel);
console.log(summary.definitions.averages.power);
```

Relic filters cover fighter, season, fight, normalized move type, exact rarity, and rarity tier.
Every breakdown includes count, percentage, and average power, speed, control, risk, complexity,
and versatility. Missing metadata and conflicting definition metadata remain explicit in coverage
and warnings instead of being silently dropped.

Market analytics expose the same split between raw data and reusable derived views:

```ts
const snapshot = await client.analytics.snapshot();
const summary = await client.analytics.summary({ productionOnly: true, from: 1_700_000_000n });

console.log(snapshot.data.buys); // raw indexed rows
console.log(summary.data.metrics); // exact bigint volume plus wallet and prediction metrics
console.log(summary.data.events); // event and per-fight breakdowns
```

Run `pnpm check:relic-parity` to compare each preset's onchain minted supply with Torii. Pass one
or more network names to narrow the check. Authenticated RPC overrides are supported through
`CAGE_CALLS_MAINNET_RPC_URL`, `CAGE_CALLS_SEPOLIA_DEV_RPC_URL`, and
`CAGE_CALLS_SEPOLIA_STAGING_RPC_URL`.

Alchemy endpoints are supported as ordinary Starknet JSON-RPC providers. The SDK does not use
Alchemy's dedicated NFT API because it does not support the Cage Calls Starknet mainnet flow.

## Deployment artifacts

Presets for `mainnet`, `sepolia-dev`, and `sepolia-staging` are generated from
[`deployment-inputs/deployments.json`](deployment-inputs/deployments.json). Each entry pins the
upstream smart-contract commit, manifest hash, addresses, class hashes, and deployed capability
flags. Run `pnpm generate`; CI rejects a stale generated file.

The new relic, fighter, gacha, and oracle views are additive and storage-preserving, but presets
continue to advertise them as unsupported until a separately authorized deployment updates the
corresponding manifest.

## Development

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm api
```

`pnpm check` validates generated deployments, strict TypeScript, Vitest, ESM/CJS declarations,
the core runtime boundary, and a 50 kB gzip core budget. The package contains no runtime
dependencies; React and React Query are optional peers.

## Security

Never commit API keys or private keys. Supply authenticated endpoints at runtime. Transport logs
contain operations and error codes, not complete endpoint URLs. Please report vulnerabilities
privately to the Medieval Tech maintainers.

MIT licensed.
