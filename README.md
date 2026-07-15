# Cage Calls SDK

Framework-neutral TypeScript access to Cage Calls deployments. The core package owns reads,
decoding, source fallbacks, validation, and typed call construction. It never owns a wallet,
signs a transaction, or waits for a receipt.

> Status: `0.1.0-next.11`. The API and deployment presets are canary-grade until the production
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

const fights = await client.fightEvents.list({ limit: 20 });
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
  },
});

const snapshot = await client.analytics.snapshot({
  traversal: { maxToriiItems: 250_000, maxRpcItems: 250_000 },
});
```

Contract-defined page sizes are still respected. Repositories iterate those pages, chunk batch
views, and stop early only when the source proves exhaustion or an authoritative count/balance
has been satisfied.

## Reads and call plans

The client exposes `fighters`, `fights`, `fightEvents`, `markets`, `relics`, `gacha`, `tokens`,
`activity`, and `admin` repositories. Mutations are constructed separately:

```ts
const plan = client.calls.gacha.strike(42n, accountAddress);
// Pass plan.calls to the wallet/controller owned by the application.
// On success, invalidate plan.invalidate in the application cache.
```

Composite plans describe Controller, VRF, and token-approval requirements without executing
them. Receipt-dependent operations are deliberately separate plans.

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

Hooks do not poll on window focus by default. Use the exported query-key factories and
`invalidateCallPlan` after application-owned transaction confirmation.

## Cartridge

```ts
import { controllerChain, sessionPoliciesForCalls } from "@medieval-tech/cage-calls-sdk/cartridge";

const chain = controllerChain(client.network);
const policies = sessionPoliciesForCalls(plan.calls);
```

These helpers only produce structural chain and policy configuration. Controller login,
account selection, signing, VRF routing, execution, and receipt waiting remain application-owned.

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

Relic feeds query Torii first and fall back to the aggregate contract view when Torii is empty
or unavailable. Use `metadata: "onchain"` while enumerating an inventory to avoid IPFS traffic,
then request the visible token page with the default `metadata: "external"` mode:

```ts
const inventory = await client.relics.feed({ limit: 20, metadata: "onchain" });
const visible = await client.relics.getMany(
  inventory.data.items.slice(0, 20).map((relic) => relic.tokenId),
);
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
