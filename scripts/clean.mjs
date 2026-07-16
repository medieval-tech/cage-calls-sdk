import { readdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const root = fileURLToPath(new URL("..", import.meta.url));
const directories = ["dist", "temp", "coverage", ".fixture-dist"];

await Promise.all(directories.map((directory) => rm(resolve(root, directory), {
  recursive: true,
  force: true,
})));

const tarballs = (await readdir(root)).filter((name) => name.endsWith(".tgz"));
await Promise.all(tarballs.map((name) => rm(resolve(root, name), { force: true })));

console.log(`Removed ${directories.length} build directories and ${tarballs.length} package tarballs.`);
