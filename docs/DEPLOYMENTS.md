# Deployment presets

Built-in presets are available for `mainnet`, `sepolia-dev`, and `sepolia-staging`. Each preset
contains the chain, world, contract and class addresses, Torii URL, Cartridge fallback RPC, VRF
address, deployment revision, and capability flags.

Presets are generated from `deployment-inputs/deployments.json`. Each input pins the upstream
smart-contract commit and manifest hash. After an additive contract migration:

1. Update the matching deployment input from the authoritative manifest.
2. Set capability flags only for views confirmed live on that deployment.
3. Run `pnpm generate`.
4. Run `pnpm check` and the relevant live parity checks.

CI runs `pnpm generate:check` and rejects stale generated artifacts.

Capability flags describe what is confirmed live, not merely what exists in the source tree.
During a staged rollout, pass `capabilities` to `createCageCallsClient` to override a preset for a
known deployment. `client.capabilities.diagnostics()` reports whether each decision came from a
preset, custom network, explicit override, or successful runtime probe. Runtime probes use valid
minimal calldata and are cached for the client lifetime.

`fightFeedByIds` requires the additive FightFactory `get_fight_feed_by_ids` view. Keep it `false`
until the upgraded class is live on that environment; older deployments continue through the
bounded per-fight feed fallback.

## Custom deployments

Pass a complete `CageCallsNetwork` object instead of a preset for Katana or an unreleased world.
Validation requires the chain ID, world and contract addresses, class hashes, Torii and Cartridge
URLs, VRF address, deployment revision, and all capability flags. The validated network is
immutable and does not modify package globals.

## Torii operations

Torii must index the contract addresses belonging to the same manifest as the selected preset.
Re-run the RelicNFT parity check after a deployment, configuration change, or reindex. See
[TORII_RELIC_RECOVERY.md](TORII_RELIC_RECOVERY.md) for the recovery procedure.
