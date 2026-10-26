#!/usr/bin/env -S node --import tsx
import { inspectPrerequisites, OperatorInputError, parseOperatorArguments, summarizePreflight } from "../../tests/scenarios/web-lifecycle/preflight.js";
import { runConnectionProbe } from "../../tests/scenarios/web-lifecycle/connection-probe.js";
import { runWebWorkspaceLifecycle } from "../../tests/scenarios/web-lifecycle/scenario.js";

async function main(): Promise<void> {
  const input = parseOperatorArguments(process.argv.slice(2));
  const checks = await inspectPrerequisites(input);
  for (const check of checks) process.stdout.write(`${check.ok ? "ok" : "fail"}\t${check.name}\t${check.detail}\n`);
  const summary = summarizePreflight(checks);
  if (!summary.ok) {
    process.stderr.write(`${summary.message}\n`);
    process.exitCode = 2;
    return;
  }
  if (input.preflightOnly) {
    process.stdout.write("web-workspace-lifecycle: preflight PASS; no workspace or runtime resource was created\n");
    return;
  }
  if (input.connectionOnly) {
    await runConnectionProbe(input.chromium);
    return;
  }
  await runWebWorkspaceLifecycle(input.image, input.chromium);
}

try {
  await main();
} catch (error) {
  if (error instanceof OperatorInputError) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
  } else {
    const category = error instanceof Error ? error.name : "UnknownFailure";
    process.stderr.write(`web-workspace-lifecycle failed (${category}); inspect the disposable host locally without publishing raw backend stderr\n`);
    process.exitCode = 1;
  }
}
