import {
  MAINNET_PRESET,
  SEPOLIA_DEV_PRESET,
  SEPOLIA_STAGING_PRESET,
  createHttpRpcTransport,
  createToriiGraphqlTransport,
  decodeByteArrayRpc,
  decodeSingleU256,
  encodeU256,
} from "../dist/index.js";

const deployments = {
  mainnet: MAINNET_PRESET,
  "sepolia-dev": SEPOLIA_DEV_PRESET,
  "sepolia-staging": SEPOLIA_STAGING_PRESET,
};

const rpcEnvironmentKeys = {
  mainnet: "CAGE_CALLS_MAINNET_RPC_URL",
  "sepolia-dev": "CAGE_CALLS_SEPOLIA_DEV_RPC_URL",
  "sepolia-staging": "CAGE_CALLS_SEPOLIA_STAGING_RPC_URL",
};

const requested = process.argv.slice(2);
const networkNames = requested.length > 0 ? requested : Object.keys(deployments);
const unknown = networkNames.filter((name) => !(name in deployments));
if (unknown.length > 0) {
  throw new Error(`Unknown network(s): ${unknown.join(", ")}.`);
}

const rows = [];
let mismatch = false;

for (const name of networkNames) {
  const network = deployments[name];
  const rpcUrl = process.env[rpcEnvironmentKeys[name]] || network.cartridgeRpcUrl;
  const rpc = createHttpRpcTransport({ url: rpcUrl, maxConcurrency: 2, maxRetries: 3 });
  const torii = createToriiGraphqlTransport({ url: network.toriiUrl, maxConcurrency: 2 });

  try {
    const [nextTokenIdResult, toriiResult] = await Promise.all([
      rpc.call({
        contractAddress: network.contracts.RelicNFT,
        entrypoint: "next_token_id",
        calldata: [],
      }),
      torii.tokens(network.contracts.RelicNFT, { offset: 0, limit: 1 }),
    ]);

    const nextTokenId = decodeSingleU256(nextTokenIdResult.data, `${name}.next_token_id`);
    const onchainCount = nextTokenId > 0n ? nextTokenId - 1n : 0n;
    const toriiCount = BigInt(toriiResult.data.totalCount);
    const sampleTokenIdValue = toriiResult.data.edges[0]?.node.tokenMetadata?.tokenId;
    const sampleTokenId = sampleTokenIdValue ? BigInt(sampleTokenIdValue) : undefined;
    let sampleOwner = "-";
    let sampleUri = "-";

    if (sampleTokenId !== undefined) {
      const [ownerResult, uriResult] = await Promise.all([
        rpc.call({
          contractAddress: network.contracts.RelicNFT,
          entrypoint: "owner_of",
          calldata: encodeU256(sampleTokenId),
        }),
        rpc.call({
          contractAddress: network.contracts.RelicNFT,
          entrypoint: "get_token_uri",
          calldata: encodeU256(sampleTokenId),
        }),
      ]);
      sampleOwner = ownerResult.data[0] || "-";
      sampleUri = decodeByteArrayRpc(uriResult.data, `${name}.token_uri`) || "-";
    }

    const matches = onchainCount === toriiCount;
    mismatch ||= !matches;
    rows.push({
      network: name,
      onchain: onchainCount.toString(),
      torii: toriiCount.toString(),
      status: matches ? "ok" : "MISMATCH",
      sampleToken: sampleTokenId?.toString() ?? "-",
      sampleOwner,
      sampleUri,
    });
  } catch (error) {
    mismatch = true;
    rows.push({
      network: name,
      onchain: "-",
      torii: "-",
      status: "ERROR",
      sampleToken: "-",
      sampleOwner: "-",
      sampleUri: "-",
      error: error?.code || error?.message || String(error),
    });
  }
}

console.table(rows);
if (mismatch) {
  console.error("RelicNFT Torii inventory does not match the onchain minted supply.");
  process.exitCode = 1;
}
