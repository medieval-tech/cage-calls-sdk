# Architecture and data sources

The SDK is a read-only domain client. It separates source access from normalized Cage Calls
repositories so browser, mobile, server, and React consumers receive the same decoded models and
fallback behavior.

## Package layout

```text
src/
  core/          shared types, validation, codecs, decoding, request budgets
  transports/    Starknet RPC, Torii GraphQL, IPFS, fallback resilience
  repositories/  Cage Calls domain reads and derived intelligence
  react/         optional React Query provider and hooks
  testing/       mock transports and test client helpers
  generated/     deployment presets and contract entrypoints
  client.ts      repository composition
  index.ts       framework-neutral public entry point
  query-keys.ts  framework-neutral cache invalidation keys
```

Only package exports are public paths. Internal source locations may change without creating new
package subpath APIs.

## Read flow

Catalog and analytics repositories prefer Torii because indexed reads are fast and efficient.
When indexed data is unavailable, empty when authoritative state proves otherwise, or incomplete,
repositories use capability-gated aggregate contract views over Starknet RPC. The configured RPC
primary is tried before fallback endpoints; Cartridge is RPC failover, not another indexer.

Relic display APIs can additionally hydrate incomplete external JSON through IPFS gateways.
Inventory and analytics APIs never fetch external media metadata. See [RELICS.md](RELICS.md).

## Completeness

Every repository returns `DataResult<T>`:

- `data` contains every valid normalized row obtained.
- `meta.source` identifies the selected source.
- `meta.complete` states whether the requested read was proven complete.
- `meta.attempts` records relevant source attempts and fallbacks.
- `meta.warnings` explains partial results, traversal ceilings, or source inconsistencies.

Partial valid data is not converted into an exception. Configuration errors, invalid arguments,
unsupported required capabilities, and failure of every eligible source use typed errors.

## Budgets and resilience

Default traversal ceilings are 100,000 Torii items across 1,000 pages and 100,000 RPC items
across 500 pages. They are safety ceilings, not desired result limits. Override shared defaults on
the client or individual reads through `RequestOptions`.

Explicit relic batches default to 100 IDs, honor contract capabilities, and adaptively split if a
provider rejects a response size. Identical concurrent reads are coalesced while in flight. Each
source has a passive circuit breaker driven by rate limits, timeouts, network errors, and server
errors; the SDK does not send background health probes.

Use `client.sources.snapshot()` or subscribe to `client.sources` for application diagnostics.
The core SDK deliberately does not cache completed reads or poll in the background.

## Application boundary

The SDK does not own accounts, session policies, calls, signatures, paymasters, receipts, or
transaction state. Applications can use the exported codecs, normalized addresses, repository
results, and query keys while keeping wallet-specific code outside this package.
