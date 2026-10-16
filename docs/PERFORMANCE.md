# Product read performance

The SDK separates bounded interactive reads from exhaustive history and collection reads. Request
counts below are part of the API design and are covered by transport-spy tests; latency depends on
the selected Torii and RPC providers.

## Interactive request shape

| Product read | Torii healthy | Torii unavailable | Notes |
| --- | --- | --- | --- |
| Event with up to 20 known fight IDs | RPC is authoritative: 1 batch | 1 batch | Requires `fightFeedByIds`; older contracts use one bounded call per fight and report a capability fallback. |
| Latest 20 fights | 1 aggregate RPC feed | 1 aggregate RPC feed | This is already an authoritative contract view and does not need historical Torii discovery. |
| First account action page | 1 account feed + up to 1 Gacha user batch | Same | Requires the additive account/Gacha views; older deployments return explicit degraded metadata. |
| Gacha pools for up to 20 fights | 1 batch | 1 batch | A selected pool on an older deployment uses one 23-call JSON-RPC HTTP batch; failed detail hydration retains open/size without an RPC fan-out. |
| Owned relic page | Indexed ownership pages + bounded hydration for incomplete owned rows | Paged ERC721 RPC recovery | Complete Torii rows cause no RPC reads; display hydration targets only incomplete owned token IDs. |
| One relic detail | 1 indexed/RPC relic read | 1 RPC relic read | IPFS is a separate lazy display request. |

Inputs larger than 20 are chunked. `RequestBudget.maxRpcItems`, `maxRpcPages`, and
`maxConcurrency` remain caller-configurable safety controls. They are not silent data caps: a read
that cannot finish within its budget reports `meta.complete: false` or rejects with a validation
error before issuing an unbounded workload.

## Reference measurements

Measurements gathered against public Sepolia deployments during the bounded-read rollout are
useful as an order-of-magnitude reference, not an SLA:

| Read | Observed latency | Requests |
| --- | ---: | ---: |
| Torii fight page | about 0.1 s | 1 |
| Known event lookup (current per-fight fallback) | about 0.3–0.4 s | 1 per known fight |
| Account feed, 20 rows | about 0.6 s | 1 |
| Full 455-fight RPC reconstruction | about 28–40 s | 23 |
| 1,095-relic indexed inventory | about 0.6 s | paged Torii |
| 1,095-relic RPC inventory | about 2 s | batched RPC |

The exact-ID FightFactory view removes the per-fight event fallback after its contract upgrade:
an event of up to 20 fights becomes one request. The 455-fight figure demonstrates why exhaustive
reconstruction must remain an explicit background/history operation rather than a screen-loading
dependency.

## Mainnet profile

`pnpm profile:prod [methodPrefix] [--runs N] [--json out.json]` calls every public read against
mainnet with real inputs (the heaviest and a typical bettor, the busiest and latest fight, the
largest event) and prints time, request count and bytes per method and per backend operation.
Set `MAINNET_RPC_URL` to the app's primary RPC. Request counts and bytes are deterministic; time
varies about ±30% between runs.

Measured 2026-10-15 (162 fights, ~54k buys, 14k relics), 0.3.0 → 0.4.0:

| Read | 0.3.0 | 0.4.0 |
| --- | --- | --- |
| `fights.feedAll` | 20.5 s, 208 req, 97 MB | 1.3 s, 15 req, 2.1 MB |
| `events.get` / `accounts.event` | 24–26 s, 97 MB | 0.8–1.8 s, 0.2–0.7 MB |
| `fights.accountFeedAll` (149 buys) | 20.2 s, 97 MB | 1.5 s, 2.2 MB |
| `fights.feed(20)` | 5.4 s, 35 req, 19.5 MB | 0.75–1.2 s, 11 req, 0.3 MB |
| `accounts.fightStates` | 4.5 s, 19.6 MB | 0.6 s, 0.4 MB |
| `fights.feedMany` / `potState` / `viewerState` (1,123-buy fight) | 0.6–1.3 s, 1.9 MB | 0.33 s, 24 KB |
| `accounts.portfolio` (149 buys) | 2.7 s, zeroed pot/claimed | 1.6 s, exact |
| `relics.inventory` / `collection` / `stats` | 28–36 s, 77 req, 35.6 MB | 2.1–2.6 s, 2 req, 8.9 MB |

Snapshot cost now grows with the number of fights read, not with buys: aggregates are summed by
Torii SQL and only the viewer's own rows are read whole. The relic inventory is bounded by Torii
serializing the collection's metadata (no gzip on `/sql`).

## Measuring a consumer

Use `DataResult.meta.durationMs`, `attempts`, `source`, `complete`, and `warnings` in development
telemetry. Count actual transport calls in integration tests with the testing entry point. Avoid
logging authenticated RPC URLs or user session material.

Performance acceptance for an interactive screen should cover both paths:

1. Torii healthy with the deployment's declared capabilities.
2. Torii disabled and the primary RPC available.
3. Primary RPC rate-limited and the configured fallback available.
4. An older deployment missing an additive view, where the SDK must stay bounded and surface a
   capability warning.
