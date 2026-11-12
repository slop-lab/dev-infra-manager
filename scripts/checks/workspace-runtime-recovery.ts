import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { runRuntimeRecovery } from "../../tests/scenarios/runtime-recovery/run.js";

const evidence = process.argv[2];
if (!evidence || process.argv.length !== 3) throw new Error("usage: workspace-runtime-recovery.ts EVIDENCE_DIRECTORY");
await mkdir(resolve(evidence), { mode: 0o700 });
await runRuntimeRecovery(resolve(evidence));
