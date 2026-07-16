import { gzipSync } from "node:zlib";
import { readFile } from "node:fs/promises";

const bytes = gzipSync(await readFile("dist/index.js")).byteLength;
const limit = 55 * 1024;
if (bytes > limit) throw new Error(`Core bundle is ${bytes} bytes gzip; limit is ${limit}.`);
console.log(`Core bundle: ${bytes} bytes gzip.`);
