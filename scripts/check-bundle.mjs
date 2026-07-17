import { gzipSync } from "node:zlib";
import { readFile } from "node:fs/promises";

const bytes = gzipSync(await readFile("dist/index.js")).byteLength;
// v0.2.0-next.9 adds Torii model composition for fight, market, position, and token state.
const limit = 59 * 1024;
if (bytes > limit) throw new Error(`Core bundle is ${bytes} bytes gzip; limit is ${limit}.`);
console.log(`Core bundle: ${bytes} bytes gzip.`);
