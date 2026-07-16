import { readFile, readdir } from "node:fs/promises";
import { relative, resolve } from "node:path";

const root = resolve("src");
const blocked = [
  /from\s+["']react/,
  /@tanstack\/react-query/,
  /\bglobalThis\.(window|document|localStorage)\b/,
  /\b(window|document|localStorage)\s*\./,
];

async function sourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(entries.map(async (entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      if (["react", "testing"].includes(entry.name)) return [];
      return sourceFiles(path);
    }
    return entry.isFile() && /\.tsx?$/.test(entry.name) ? [path] : [];
  }));
  return files.flat();
}

for (const path of await sourceFiles(root)) {
  const name = relative(root, path);
  const source = await readFile(path, "utf8");
  for (const pattern of blocked) {
    if (pattern.test(source)) throw new Error(`Core boundary violation in ${name}: ${pattern}`);
  }
}
