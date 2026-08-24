import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
const policy = JSON.parse(readFileSync(path.join(root, "repository-boundaries.json"), "utf8"));
if (policy.schemaVersion !== 1 || typeof policy.owners !== "object") {
  throw new Error("unsupported repository boundary policy");
}

const tracked = execFileSync("git", ["-C", root, "ls-files"], { encoding: "utf8" })
  .trim()
  .split("\n")
  .filter(Boolean);
const failures = [];

for (const file of tracked) {
  const matches = [];
  for (const [owner, rules] of Object.entries(policy.owners)) {
    if (rules.files?.includes(file)) matches.push({ owner, length: file.length + 1 });
    for (const prefix of rules.prefixes ?? []) {
      if (file.startsWith(prefix)) matches.push({ owner, length: prefix.length });
    }
  }
  if (matches.length === 0) {
    failures.push(`${file}: no future repository owner`);
    continue;
  }
  const longest = Math.max(...matches.map(({ length }) => length));
  const owners = [...new Set(matches.filter(({ length }) => length === longest).map(({ owner }) => owner))];
  if (owners.length !== 1) failures.push(`${file}: ambiguous owners ${owners.join(", ")}`);
}

if (failures.length > 0) {
  process.stderr.write(`${failures.join("\n")}\n`);
  process.exit(1);
}

console.log(`repository-boundaries-ok (${tracked.length} tracked files)`);
