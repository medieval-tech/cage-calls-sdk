import {
  SEPOLIA_STAGING_PRESET,
  createCageCallsClient,
  createHttpRpcTransport,
} from "@medieval-tech/cage-calls-sdk";

// Capacitor owns native authentication and storage; the SDK only receives platform fetch.
const client = createCageCallsClient({
  network: "sepolia-staging",
  transports: {
    rpc: createHttpRpcTransport({
      url: SEPOLIA_STAGING_PRESET.cartridgeRpcUrl,
      fetch: globalThis.fetch,
    }),
  },
});

const target = document.querySelector<HTMLElement>("#app");
if (target) target.textContent = `Cage Calls ${client.network.name}`;
