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

async function countToriiTokens(torii, contract) {
  const tokenIds = new Set();
  const countResult = await torii.tokens(contract, { offset: 0, limit: 0 });
  const rawTotal = countResult.data.totalCount;
  const tokenRowCount = Math.max(0, rawTotal - 1);
  const result = tokenRowCount > 0
    ? await torii.tokens(contract, { offset: 0, limit: Math.min(1000, tokenRowCount) })
    : countResult;
  for (const edge of result.data.edges) {
    const tokenId = edge.node.tokenMetadata?.tokenId;
    if (tokenId) tokenIds.add(BigInt(tokenId).toString());
  }

  // Torii stores one collection-level row alongside the ERC721 token rows. Its
  // current token resolver cannot paginate past the 1,000-row offset window,
  // so totalCount is the authoritative count once that window is exceeded.
  const count = BigInt(tokenRowCount);
  if (rawTotal <= 1000 && BigInt(tokenIds.size) !== count) {
    throw new Error(`Torii returned ${tokenIds.size} token IDs for ${rawTotal} collection rows.`);
  }

  return { count, rawTotal, sampleTokenId: tokenIds.values().next().value };
}

for (const name of networkNames) {
  const network = deployments[name];
  const rpcUrl = process.env[rpcEnvironmentKeys[name]] || network.cartridgeRpcUrl;
  const rpc = createHttpRpcTransport({ url: rpcUrl, maxConcurrency: 2, maxRetries: 3 });
  const torii = createToriiGraphqlTransport({ url: network.toriiUrl, maxConcurrency: 2 });

  try {
    const [nextTokenIdResult, toriiInventory] = await Promise.all([
      rpc.call({
        contractAddress: network.contracts.RelicNFT,
        entrypoint: "next_token_id",
        calldata: [],
      }),
      countToriiTokens(torii, network.contracts.RelicNFT),
    ]);

    const nextTokenId = decodeSingleU256(nextTokenIdResult.data, `${name}.next_token_id`);
    const onchainCount = nextTokenId > 0n ? nextTokenId - 1n : 0n;
    const toriiCount = toriiInventory.count;
    const sampleTokenId = toriiInventory.sampleTokenId ? BigInt(toriiInventory.sampleTokenId) : undefined;
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
      toriiRows: toriiInventory.rawTotal.toString(),
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
      toriiRows: "-",
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
