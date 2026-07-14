import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve("src");
const blocked = [
  /from\s+["']react/,
  /@tanstack\/react-query/,
  /\bglobalThis\.(window|document|localStorage)\b/,
  /\b(window|document|localStorage)\s*\./,
];

for (const name of await readdir(root)) {
  if (!name.endsWith(".ts") || ["react.tsx"].includes(name)) continue;
  const source = await readFile(resolve(root, name), "utf8");
  for (const pattern of blocked) {
    if (pattern.test(source)) throw new Error(`Core boundary violation in ${name}: ${pattern}`);
  }
}
