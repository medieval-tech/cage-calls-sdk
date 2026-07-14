import { MAINNET_PRESET, createCageCallsClient } from "@medieval-tech/cage-calls-sdk";
import { createMockRpcTransport } from "@medieval-tech/cage-calls-sdk/testing";

const client = createCageCallsClient({
  network: "mainnet",
  transports: { rpc: createMockRpcTransport({ calls: { balance_of: ["42", "0"] } }) },
});

const balance = await client.tokens.callsBalance("0x1");
if (balance.data !== 42n || client.network.worldAddress !== MAINNET_PRESET.worldAddress) {
  throw new Error("Node fixture returned unexpected SDK data.");
}
