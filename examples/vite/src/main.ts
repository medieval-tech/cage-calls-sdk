import { MAINNET_PRESET, createCageCallsClient } from "@medieval-tech/cage-calls-sdk";
import { createMockRpcTransport } from "@medieval-tech/cage-calls-sdk/testing";

const client = createCageCallsClient({
  network: "mainnet",
  transports: { rpc: createMockRpcTransport() },
});

const target = document.querySelector<HTMLDivElement>("#app");
if (target) target.textContent = `Cage Calls ${client.network.name} ${MAINNET_PRESET.deploymentRevision}`;
