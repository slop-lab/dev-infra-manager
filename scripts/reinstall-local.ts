#!/usr/bin/env node
import { parseArgs } from "node:util";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { removalPaths } from "./local-uninstall/paths.ts";
import { createRemovalPlan } from "./local-uninstall/plan.ts";
import { selectCacheRetention, confirmRemoval, terminalQuestions } from "./local-uninstall/prompts.ts";
import { showRemovalPlan } from "./local-uninstall/presentation.ts";
import { cacheRestoreSelection, cacheRestoreArtifacts, restoreCaches } from "./local-uninstall/restore-caches.ts";
import { checked, command, type Command } from "./local-uninstall/command.ts";
const parsed = parseArgs({ options: { yes: { type: "boolean", short: "y" }, "with-managed": { type: "boolean" }, "keep-cache-data": { type: "boolean" }, "no-keep-cache-data": { type: "boolean" }, "dry-run": { type: "boolean" }, help: { type: "boolean", short: "h" } }, allowPositionals: false });
const questions = terminalQuestions();
const visible: Command = async (file, args) => new Promise((resolve, reject) => {
  const child = spawn(file, [...args], { stdio: "inherit", env: process.env });
  child.once("error", reject); child.once("close", (status) => resolve({ status: status ?? 1, stdout: "", stderr: "see command output above" }));
});
try {
  if (parsed.values.help) console.log("Usage: just reinstall-local [-y] [--with-managed] [--keep-cache-data | --no-keep-cache-data] [--dry-run]\n\nKeep cache data defaults to yes. TTY use asks before removal; noninteractive execution needs -y.\nReinstalls the prepared candidate, restores previously used local caches and mirror connections.");
  else {
    const flags = { yes: parsed.values.yes === true, keepCacheData: parsed.values["keep-cache-data"] === true, noKeepCacheData: parsed.values["no-keep-cache-data"] === true, dryRun: parsed.values["dry-run"] === true };
    const keepCacheData = await selectCacheRetention(flags, questions), paths = removalPaths();
    const cache = await cacheRestoreSelection(paths), bundle = join(paths.repository, ".local/dim-packages");
    const artifacts = await cacheRestoreArtifacts(bundle, cache, paths);
    const plan = await createRemovalPlan(paths, undefined, undefined, { keepCacheData });
    showRemovalPlan(plan);
    if (cache.kinds.length) console.log(`After installation: restore ${cache.kinds.join(", ")} caches${cache.mirrors ? " and workspace mirror connections" : ""}.`);
    if (await confirmRemoval(flags, questions)) {
      console.log("Removing the selected local installation…");
      await checked(command, "bash", [join(paths.repository, "scripts/uninstall-source-build.bash"), "-y", keepCacheData ? "--keep-cache-data" : "--no-keep-cache-data"]);
      await checked(visible, "bash", [join(paths.repository, "scripts/install-source-build.bash"), ...(parsed.values["with-managed"] ? ["--with-managed"] : [])]);
      await restoreCaches(cache, keepCacheData, paths, bundle, artifacts.facade, artifacts.plugins, visible);
      console.log("Local reinstall complete.");
    } else if (!questions.tty && !flags.dryRun) throw new Error("noninteractive reinstall needs -y; use --dry-run to preview");
    else console.log(flags.dryRun ? "Preview only." : "Reinstall cancelled.");
  }
} catch (error) { console.error(`reinstall-local: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; }
finally { questions.close(); }
