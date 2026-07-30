import { gzipSync } from "node:zlib";
import { readFile } from "node:fs/promises";

const bytes = gzipSync(await readFile("dist/index.js")).byteLength;
// v0.2.0-next.11 adds provider-level JSON-RPC batching and legacy Gacha pool hydration.
//
// Raised 60 -> 62 KiB in 0.2.2: the Katana preset added a fourth set of contract
// addresses and class hashes, pushing the bundle 151 bytes (0.25%) over the previous
// limit. That is static data for a legitimately new network rather than code bloat,
// so the budget was raised deliberately instead of worked around.
//
// Each extra network costs roughly this much. If a fifth is ever added, prefer
// splitting presets out of the core entrypoint over raising this again — mainnet
// users currently download the dev, staging and Katana addresses they never use.
const limit = 62 * 1024;
if (bytes > limit) throw new Error(`Core bundle is ${bytes} bytes gzip; limit is ${limit}.`);
console.log(`Core bundle: ${bytes} bytes gzip.`);
