import { execFileSync } from "node:child_process";
import { closeSync, fchmodSync, openSync, writeFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

const arguments_ = process.argv.slice(2);
const [expectedCommit, output] = arguments_;
if (arguments_.length !== 2 || !/^[0-9a-f]{40}$/.test(expectedCommit ?? "") || !isAbsolute(output ?? "")) {
  throw new Error("expected a complete lowercase candidate commit and absolute evidence path");
}

const root = resolve(process.cwd());
function git(...gitArguments) {
  return execFileSync("git", gitArguments, {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_MASTER: "1",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_COUNT: "0",
    },
  }).trim();
}

if (resolve(git("rev-parse", "--show-toplevel")) !== root) {
  throw new Error("candidate evidence must run from the checkout root");
}

const candidateCommit = git("rev-parse", "--verify", "HEAD");
if (candidateCommit !== expectedCommit) {
  throw new Error("checked-out candidate commit does not match expected commit");
}
if (git("status", "--porcelain=v1", "--untracked-files=no") !== "") {
  throw new Error("candidate checkout has tracked changes");
}

const candidateTree = git("rev-parse", "--verify", "HEAD^{tree}");
const evidence = `${JSON.stringify({
  schemaVersion: 1,
  candidateCommit,
  candidateTree,
}, null, 2)}\n`;
const descriptor = openSync(output, "wx", 0o600);
try {
  fchmodSync(descriptor, 0o600);
  writeFileSync(descriptor, evidence, "utf8");
} finally {
  closeSync(descriptor);
}

console.log(`candidate-commit=${candidateCommit} candidate-tree=${candidateTree}`);
