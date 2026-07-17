# Cage Calls SDK

Framework-neutral TypeScript reads and collection intelligence for Cage Calls. The SDK owns
network presets, decoding, Torii-first reads, Starknet RPC fallback, IPFS metadata hydration,
completeness reporting, aggregation, and optional React Query bindings.

The SDK is deliberately read-only. Wallet connection, Cartridge Controller policies,
transaction construction, signing, receipt handling, and post-transaction invalidation stay in
the consuming application.

The current `0.2.0-next` line is a canary API used by the Cage Calls client and available for
mobile integration testing.

## Install

```sh
pnpm add @medieval-tech/cage-calls-sdk
```

For React Query bindings:

```sh
pnpm add @medieval-tech/cage-calls-sdk @tanstack/react-query react
```

Node 18+, browsers, modern edge runtimes, and Capacitor are supported. Runtimes must provide
`fetch`, `URL`, `AbortController`, and `BigInt`; every HTTP transport accepts a custom `fetch`.

## Quick start

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
    torii: createToriiGraphqlTransport({ url: MAINNET_PRESET.toriiUrl }),
    rpc: createFallbackRpcTransport({
      primaryUrl: process.env.ALCHEMY_RPC_URL,
      fallbackUrl: MAINNET_PRESET.cartridgeRpcUrl,
    }),
    metadata: createIpfsMetadataTransport({
      gateways: ["https://gateway.pinata.cloud/ipfs/"],
    }),
  },
});

const fights = await client.fightEvents.page({ limit: 20 });
console.log(fights.data.items, fights.meta);

// When an event service already knows the fight IDs, avoid historical discovery.
const account = "0x123";
const event = await client.fightEvents.get("Cage Night", {
  seasonId: 1n,
  fightIds: [42n, 43n],
  viewer: account,
});

// Load only the first actionable account page; fetch older pages on demand.
const accountPage = await client.accounts.fightStates(account, { limit: 20 });
```

Every read returns a `DataResult<T>`. Its `meta` field reports the selected source, fallback
attempts, completeness, warnings, duration, and block number when available. Valid partial data
resolves with `complete: false`; invalid configuration and total source failure throw typed SDK
errors.

## Capabilities

The client exposes `fighters`, `fights`, `fightEvents`, `events`, `accounts`, `markets`,
`relics`, `gacha`, `tokens`, `activity`, `analytics`, and `admin` repositories.

- Indexed catalogs and analytics query Torii first.
- Authoritative or missing state falls back to the configured Starknet RPC.
- RPC pools try the primary provider before Cartridge failover.
- External IPFS JSON is fetched only by display-oriented relic reads and only when needed.
- Exhaustive reads have configurable safety budgets rather than arbitrary result caps.
- Concurrent identical work is coalesced; the core SDK does not retain completed-result caches.
- Known fight IDs, Gacha pools, and account-relevant fight state use bounded contract batches.
- Legacy Gacha deployments reconstruct one selected pool's complete rarity counters in one JSON-RPC
  HTTP batch; a failed batch retains only verified open/size state instead of starting an RPC fan-out.
- `client.capabilities.diagnostics()` reports preset, override, and runtime-probe provenance.

## Entry points

- `@medieval-tech/cage-calls-sdk`: framework-neutral client, repositories, types, transports, and
  pure statistics helpers.
- `@medieval-tech/cage-calls-sdk/react`: provider, React Query hooks, and live invalidation.
- `@medieval-tech/cage-calls-sdk/testing`: mock RPC, Torii, and metadata transports.

## Guides

- [Architecture and source fallback](docs/ARCHITECTURE.md)
- [Mobile integration](docs/MOBILE.md)
- [Product read performance](docs/PERFORMANCE.md)
- [Relic reads and statistics](docs/RELICS.md)
- [React Query integration](docs/REACT.md)
- [Deployment presets](docs/DEPLOYMENTS.md)
- [Torii RelicNFT recovery](docs/TORII_RELIC_RECOVERY.md)
- [Development and releases](docs/RELEASING.md)

## Development

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm clean
```

`pnpm check` validates generated deployments, strict TypeScript, Vitest, ESM/CJS declarations,
Node/SSR/Vite/Capacitor runtime examples, the public API report, the non-React core boundary, and
the gzip bundle budget.

## Security

Never commit API keys or private keys. Supply authenticated endpoints at runtime. Transport logs
contain operations and error codes, not complete authenticated URLs. Report vulnerabilities
privately to the Medieval Tech maintainers.

MIT licensed.
