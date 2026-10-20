import { spawnSync } from "node:child_process";
import { packageDirectories } from "../pack-local-packages.ts";

for (const directory of packageDirectories) {
  const result = spawnSync("bash", ["scripts/packages/pnpm-pack-dry-run.bash", directory], { encoding: "utf8" });
  if (result.status !== 0) {
    process.stderr.write(`${directory} package check failed\n${result.stdout}${result.stderr}`);
    process.exit(result.status ?? 1);
  }
}
process.stdout.write(`[check] package-packs passed packages=${packageDirectories.length}\n`);
