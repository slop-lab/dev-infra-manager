import { execFileSync } from "node:child_process";
import { chmod, copyFile, lstat, mkdir, readFile, readlink, symlink } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
const destination = process.argv[2] ? path.resolve(process.argv[2]) : undefined;
if (!destination) throw new Error("usage: node .dim/materialize-repository-boundaries.mjs <destination>");
if (destination === root || destination.startsWith(`${root}${path.sep}`)) {
  throw new Error("destination must be outside the source checkout");
}

const policy = JSON.parse(await readFile(path.join(root, "repository-boundaries.json"), "utf8"));
if (policy.schemaVersion !== 1 || typeof policy.owners !== "object") throw new Error("unsupported repository boundary policy");
const tracked = execFileSync("git", ["-C", root, "ls-files", "-z"], { encoding: "utf8" }).split("\0").filter(Boolean);
const counts = new Map();
await mkdir(destination, { recursive: false });

function resolveOwner(file) {
  const matches = [];
  for (const [owner, rules] of Object.entries(policy.owners)) {
    if (rules.files?.includes(file)) matches.push({ owner, rules, length: file.length + 1 });
    for (const prefix of rules.prefixes ?? []) if (file.startsWith(prefix)) matches.push({ owner, rules, length: prefix.length });
  }
  const longest = Math.max(...matches.map(({ length }) => length));
  const winners = matches.filter(({ length }) => length === longest);
  if (winners.length !== 1) throw new Error(`${file}: expected exactly one owner`);
  return winners[0];
}

for (const file of tracked) {
  const { owner, rules } = resolveOwner(file);
  if (rules.extract === false) continue;
  if (!rules.repository || typeof rules.targetPrefix !== "string") throw new Error(`${owner}: incomplete extraction contract`);
  if (!file.startsWith(rules.targetPrefix)) throw new Error(`${file}: does not start with ${owner} targetPrefix`);
  const relative = file.slice(rules.targetPrefix.length);
  if (!relative || relative.startsWith("/") || relative.split("/").includes("..")) throw new Error(`${file}: unsafe extracted path`);
  const target = path.join(destination, rules.repository, relative);
  await mkdir(path.dirname(target), { recursive: true });
  const source = path.join(root, file);
  const stat = await lstat(source);
  if (stat.isSymbolicLink()) await symlink(await readlink(source), target);
  else {
    await copyFile(source, target);
    await chmod(target, stat.mode);
  }
  counts.set(owner, (counts.get(owner) ?? 0) + 1);
}

for (const [owner, rules] of Object.entries(policy.owners)) {
  if (rules.extract !== false && !counts.has(owner)) throw new Error(`${owner}: extracted no files`);
}
console.log([...counts].map(([owner, count]) => `${owner}=${count}`).join(" "));
