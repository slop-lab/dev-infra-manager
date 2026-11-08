import { spawnSync } from "node:child_process";
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
process.chdir(root);
process.umask(0o077);
if (!["v24.19.0", "v26.5.0"].includes(process.version)) {
  throw new Error("portable checks require Node 24.19.0 or 26.5.0");
}
const pnpm = spawnSync("pnpm", ["--version"], { encoding: "utf8" });
if (pnpm.status !== 0 || pnpm.stdout.trim() !== "10.13.1") {
  throw new Error("portable checks require pnpm 10.13.1");
}
const parent = process.env.DIM_CHECK_LOG_DIR ?? join(root, ".local/portable-checks");
mkdirSync(parent, { recursive: true, mode: 0o700 });
const logs = mkdtempSync(join(parent, "run."));
const packs = join(logs, "package-packs");
mkdirSync(packs, { mode: 0o700 });
console.log(`[check] logs: ${logs}`);
const stages: ReadonlyArray<readonly [string, readonly string[]]> = [
  ["dependencies", ["install", "--frozen-lockfile"]],
  ["cli-host-types", ["--filter", "@slop-lab/dim-contracts-cli-host", "run", "check"]],
  ["cli-host-build", ["--filter", "@slop-lab/dim-contracts-cli-host", "run", "build"]],
  ["cli-host-pack", ["--dir", "packages/contracts/cli-host", "pack", "--pack-destination", packs]],
  ["portable-contracts", ["--dir", "tests", "exec", "vitest", "run", "contracts/cliHost.test.ts", "host/core/application/cliHostProtocol.test.ts", "host/core/sourceArchitecture.test.ts", "scenarios/harness/localPackageIdentity.test.ts", "--maxWorkers=2"]],
  ["cli-host-transport", ["--dir", "tests", "exec", "tsx", "--conditions=dim-source", "--test", "cli/hostTransport.test.ts"]]
];
for (const [index, [name, args]] of stages.entries()) {
  const log = join(logs, `${String(index + 1).padStart(2, "0")}-${name}.log`);
  const started = performance.now();
  console.log(`[check] ${name} started=${new Date().toISOString()}`);
  const descriptor = openSync(log, "wx", 0o600);
  let result;
  try {
    result = spawnSync("pnpm", [...args], {
      stdio: ["ignore", descriptor, descriptor],
      env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: undefined }
    });
  } finally { closeSync(descriptor); }
  const exitCode = result.status ?? 1;
  writeFileSync(join(logs, "stages.jsonl"), JSON.stringify({
    stage: name, utc: new Date().toISOString(), elapsedMilliseconds: Math.round(performance.now() - started),
    exitCode, signal: result.signal, launchCode: result.error && "code" in result.error ? result.error.code : null
  }) + "\n", { flag: "a", mode: 0o600 });
  if (exitCode !== 0) {
    console.error(`[check] FAIL ${name} exit=${exitCode} signal=${result.signal ?? "none"} log=${log} (last 160 lines)`);
    process.stderr.write(readFileSync(log, "utf8").split("\n").slice(-161).join("\n"));
    process.exit(exitCode);
  }
}
console.log(`[check] portable complete stages=${stages.length} logs=${logs}; full DIM source/runtime qualification is separate`);
