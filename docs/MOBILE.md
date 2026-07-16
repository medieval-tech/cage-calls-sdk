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

## Integration checklist

1. Select a built-in preset or pass a complete custom `CageCallsNetwork`.
2. Configure Torii plus a dedicated Starknet RPC and Cartridge fallback.
3. Surface incomplete reads and warnings in diagnostics.
4. Fetch display metadata only for visible relics; use inventory reads for counts and analytics.
5. Test Node/SSR-equivalent startup and the target native/webview runtime before release.
