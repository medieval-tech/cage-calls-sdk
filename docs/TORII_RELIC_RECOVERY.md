# RelicNFT Torii recovery

Run the parity check before and after every Torii deployment or reindex:

```sh
pnpm check:relic-parity sepolia-dev
pnpm check:relic-parity sepolia-staging
pnpm check:relic-parity mainnet
```

The check compares `RelicNFT.next_token_id - 1` with Torii's contract-filtered ERC-721 token
count. It also verifies that Torii's first token can be read from the contract and reports its
owner and token URI. A mismatch exits non-zero.

If Torii reports fewer tokens than the contract:

1. Confirm the Torii configuration indexes the current RelicNFT address from the matching
   deployment manifest.
2. Preserve the current database or volume for rollback and diagnostics.
3. Rebuild the index from genesis into a fresh database/volume. Do not reuse a database that
   already completed an incomplete token backfill.
4. Wait for the indexer head to catch the chain head, then rerun the parity check.
5. Promote the rebuilt service only after the count matches. Recover environments in the order
   `sepolia-dev`, `sepolia-staging`, then `mainnet`.

If a fresh rebuild still returns zero tokens, keep the SDK RPC fallback enabled and capture the
Torii version, configured contract address, sync head, and ERC-721 transfer event query before
escalating. Never delete the only production Torii database as part of recovery.
