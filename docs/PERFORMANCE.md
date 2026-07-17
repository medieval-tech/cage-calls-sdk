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
| Gacha pools for up to 20 fights | 1 batch | 1 batch | Older deployments use bounded concurrent singleton calls. |
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
