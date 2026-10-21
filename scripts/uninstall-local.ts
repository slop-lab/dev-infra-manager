#!/usr/bin/env node
import { parseArgs } from "node:util";
import { removalPaths } from "./local-uninstall/paths.ts";
import { createRemovalPlan, executeRemoval } from "./local-uninstall/plan.ts";
import { selectCacheRetention, confirmRemoval, terminalQuestions } from "./local-uninstall/prompts.ts";
import { showRemovalPlan } from "./local-uninstall/presentation.ts";
const parsed = parseArgs({ options: { yes: { type: "boolean", short: "y" }, "keep-cache-data": { type: "boolean" }, "no-keep-cache-data": { type: "boolean" }, "dry-run": { type: "boolean" }, help: { type: "boolean", short: "h" } }, allowPositionals: false });
const questions = terminalQuestions();
try {
  if (parsed.values.help) console.log("Usage: just uninstall-local [-y] [--keep-cache-data | --no-keep-cache-data] [--dry-run]\n\nInteractive cache retention defaults to yes; removal requires confirmation.\n-y skips prompts and retains cache data unless --no-keep-cache-data is set.\nNoninteractive use without -y previews only. Shared host tools and source artifacts remain.");
  else {
    const flags = { yes: parsed.values.yes === true, keepCacheData: parsed.values["keep-cache-data"] === true, noKeepCacheData: parsed.values["no-keep-cache-data"] === true, dryRun: parsed.values["dry-run"] === true };
    const keepCacheData = await selectCacheRetention(flags, questions);
    const plan = await createRemovalPlan(removalPaths(), undefined, undefined, { keepCacheData });
    showRemovalPlan(plan);
    if (await confirmRemoval(flags, questions)) {
      await executeRemoval(plan);
      console.log(`Local DIM installation removed. Service data/authentication, prepared source artifacts${keepCacheData ? " and cache data" : ""} are retained.`);
    } else console.log(flags.dryRun || !questions.tty ? "Preview only. Use -y to execute noninteractively." : "Removal cancelled.");
  }
} catch (error) { console.error(`uninstall-local: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; }
finally { questions.close(); }
