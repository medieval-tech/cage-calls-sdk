delete globalThis.window;
delete globalThis.document;
delete globalThis.localStorage;

const sdk = await import("@medieval-tech/cage-calls-sdk");
if (typeof sdk.createCageCallsClient !== "function") {
  throw new Error("SSR fixture could not import the core SDK.");
}
