import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const [expected, output] = process.argv.slice(2);
if (!/^[0-9a-f]{40}$/.test(expected ?? "") || !output?.startsWith("/")) {
  throw new Error("expected a complete lowercase candidate commit and absolute evidence path");
}
const root = process.cwd();
const evidenceRoot = join(root, ".monorepo-candidate");

function git(...args) {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, GIT_MASTER: "1", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_COUNT: "0" }
  }).trim();
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function rows(filename, header, fields) {
  const lines = readFileSync(join(evidenceRoot, filename), "utf8").trimEnd().split("\n");
  if (lines.shift() !== header || lines.length === 0) throw new Error(`invalid candidate ${filename} header`);
  return lines.map((line) => {
    const parts = line.split("\t");
    if (parts.length !== fields) throw new Error(`invalid candidate ${filename} row`);
    return parts;
  });
}

const commit = git("rev-parse", "HEAD");
if (commit !== expected) throw new Error("checked-out candidate commit does not match dispatch identity");
const tree = git("rev-parse", "HEAD^{tree}");

const overlayManifest = readFileSync(join(evidenceRoot, "overlay.tsv"));
const overlayDigest = readFileSync(join(evidenceRoot, "overlay.digest"), "utf8").trim();
if (sha256(overlayManifest) !== overlayDigest) throw new Error("candidate overlay manifest digest changed");
const overlays = rows("overlay.tsv", "input\ttarget\tsha256", 3);
const inputs = new Set();
const targets = new Set();
for (const [input, target, digest] of overlays) {
  if (!/^[a-zA-Z0-9._-]+$/.test(input) || !target || inputs.has(input) || targets.has(target)
    || sha256(readFileSync(join(evidenceRoot, "overlay", input))) !== digest) {
    throw new Error("candidate overlay bytes or identity changed");
  }
  inputs.add(input);
  targets.add(target);
}

const sources = rows("sources.tsv", "repository\tdestination\tsource_commit\tsource_tree\tcollision_policy", 5);
const expectedSources = new Set([
  "development", "root", "core", "core-development", "plugin-dns-cloudflare",
  "plugin-dns-cloudflare-development", "plugin-external-urls", "plugin-external-urls-development",
  "verification", "examples", "specification"
]);
if (sources.length !== expectedSources.size) throw new Error("candidate source inventory changed");
for (const [repository, destination, sourceCommit, sourceTree] of sources) {
  if (!expectedSources.delete(repository) || !/^[0-9a-f]{40}$/.test(sourceCommit)
    || !/^[0-9a-f]{40}$/.test(sourceTree)
    || git("rev-parse", "--verify", `${sourceCommit}^{tree}`) !== sourceTree) {
    throw new Error(`candidate source identity changed: ${repository}`);
  }
  git("merge-base", "--is-ancestor", sourceCommit, commit);
  if (destination !== "." && repository !== "verification"
    && git("rev-parse", `HEAD:${destination}`) !== sourceTree) {
    throw new Error(`candidate source tree changed: ${repository}`);
  }
}

const github = rows("github-development.tsv", "repository\tsource_commit\tsource_tree\tancestry_policy", 4);
if (github.length !== 1 || github[0][0] !== "github-development"
  || !/^[0-9a-f]{40}$/.test(github[0][1]) || !/^[0-9a-f]{40}$/.test(github[0][2])
  || git("rev-parse", "--verify", `${github[0][1]}^{tree}`) !== github[0][2]) {
  throw new Error("candidate GitHub history identity changed");
}
git("merge-base", "--is-ancestor", github[0][1], commit);

writeFileSync(resolve(output), `${JSON.stringify({
  schemaVersion: 1,
  candidateCommit: commit,
  candidateTree: tree,
  overlayDigest,
  sources: sources.map(([repository, destination, sourceCommit, sourceTree]) => ({ repository, destination, sourceCommit, sourceTree })),
  githubDevelopment: { commit: github[0][1], tree: github[0][2] }
}, null, 2)}\n`, { flag: "wx", mode: 0o600 });
console.log(`candidate-commit=${commit} candidate-tree=${tree} overlay-digest=${overlayDigest}`);
