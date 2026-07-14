import { gzipSync } from "node:zlib";
import { readFile } from "node:fs/promises";

const bytes = gzipSync(await readFile("dist/index.js")).byteLength;
if (bytes > 50 * 1024) throw new Error(`Core bundle is ${bytes} bytes gzip; limit is 51200.`);
console.log(`Core bundle: ${bytes} bytes gzip.`);
