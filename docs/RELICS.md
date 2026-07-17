# Relic reads and collection statistics

Relic APIs separate authoritative collection data from optional display metadata so analytics do
not spend RPC or IPFS capacity on information they do not need.

## Choosing a read

- `relics.inventory()` traverses indexed collection rows for analytics, exports, and counts without
  fetching external token JSON or hydrating every relic through RPC.
- `relics.ownedInventory(owner)` provides the same Torii-first inventory behavior for one owner.
- `relics.collection()` returns display-ready collection data and selectively hydrates incomplete
  external metadata through the configured IPFS gateways.
- `relics.owned(owner)` is the display-oriented owned collection equivalent. It keeps Torii as the
  ownership source and batch-hydrates only owned token IDs whose indexed media metadata is incomplete.
- `relics.feed()` and paginated methods are intended for bounded surfaces.

Torii is queried first. Complete indexed rows are accepted directly. Display-oriented owned reads
use bounded RPC hydration only for incomplete owned rows; analytics inventory reads do not.

```ts
const inventory = await client.relics.inventory({ pageSize: 200 });
const display = await client.relics.collection({ pageSize: 200 });
const firstPage = display.data.items.slice(0, 20);
```

## Statistics

`relics.stats()` exposes ready-made collection summaries. Pure helpers can recompute or extend the
same metrics without another network request:

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

console.log(summary.minted.byMoveType);
console.log(summary.definitions.byRarityLevel);
console.log(summary.definitions.averages.power);
```

Filters cover fighter, season, fight, normalized move type, exact rarity, and rarity tier.
Breakdowns include count, percentage, and average power, speed, control, risk, complexity, and
versatility. Coverage and warning fields retain missing or conflicting definition metadata.

## Operational parity

Run `pnpm check:relic-parity` to compare an onchain minted supply with Torii. Network-specific RPC
overrides use `CAGE_CALLS_MAINNET_RPC_URL`, `CAGE_CALLS_SEPOLIA_DEV_RPC_URL`, and
`CAGE_CALLS_SEPOLIA_STAGING_RPC_URL`. Follow [TORII_RELIC_RECOVERY.md](TORII_RELIC_RECOVERY.md)
when counts diverge.
