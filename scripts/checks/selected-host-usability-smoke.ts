#!/usr/bin/env -S node --import tsx
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { helpText, OperatorInputError, SmokeFailure, parseOperatorArguments, parseSmokeConfiguration } from "../../tests/scenarios/selected-host/config.js";
import { preflightHost, runHostSmoke } from "../../tests/scenarios/selected-host/scenario.js";
import { monitorInspection } from "../../tests/scenarios/selected-host/monitorCommand.ts";
import { verifyIsolatedInstallationUpdate } from "../../tests/scenarios/selected-host/isolatedUpdate.js";
import { runCommand } from "../../tests/scenarios/web-lifecycle/process.js";
import { smokeProgress } from "../../tests/scenarios/selected-host/progress.ts";
import { fixtureFailureWriter, type CommandEvidence } from "../../tests/scenarios/selected-host/selectedCommand.js";
import type { OrdinaryRuntimeVersions } from "../../tests/scenarios/selected-host/ordinaryLifecycle.js";

function configurationReportPath(): string {
  const target = process.env.DIM_PRACTICAL_CI_REPORT;
  if (!target?.startsWith("/")) throw new OperatorInputError("generated practical fixture report path is required for private diagnostics");
  return target;
}

async function main(): Promise<void> {
  const values = process.argv.slice(2);
  if (values.length === 1 && ["--help", "-h"].includes(values[0] ?? "")) {
    process.stdout.write(`${helpText}\n`);
    return;
  }
  const input = parseOperatorArguments(values), progress = smokeProgress();
  const configuration = parseSmokeConfiguration(JSON.parse(await readFile(input.configPath, "utf8")));
  const selected = input.hosts.map((name) => {
    const profile = configuration.hosts.find((candidate) => candidate.name === name);
    if (profile === undefined) throw new OperatorInputError(`selected host '${name}' has no reviewed profile in ${input.configPath}`);
    return profile;
  });
  let available = true;
  const preflights: { readonly host: string; readonly ok: boolean; readonly details: readonly string[] }[] = [];
  for (const profile of selected) {
    progress.phase(profile.name, "checking selected-host version, capabilities and ownership");
    const result = await preflightHost(profile, configuration.installedSourceSha);
    preflights.push({ host: profile.name, ...result });
    if (!input.json) for (const detail of result.details) process.stdout.write(`${result.ok ? "ok" : "unavailable"}\t${profile.name}\t${detail}\n`);
    available = available && result.ok;
  }
  if (!available) {
    if (input.json) process.stdout.write(`${JSON.stringify({ outcome: "unavailable", completion: "not-assessed", preflights })}\n`);
    else process.stderr.write("selected-host smoke stopped before workspace creation; required live capabilities are unavailable\n");
    process.exitCode = 2;
    return;
  }
  if (input.preflightOnly) {
    if (input.json) process.stdout.write(`${JSON.stringify({ outcome: "preflight-passed", completion: "not-assessed", preflights })}\n`);
    else process.stdout.write("selected-host smoke preflight passed; no workspace was created\n");
    return;
  }
  const sourceRoot = fileURLToPath(new URL("../../", import.meta.url));
  const sourceStatus = await runCommand("git", ["-C", sourceRoot, "status", "--porcelain=v1"]);
  if (sourceStatus.stdout.trim()) throw new OperatorInputError("real selected-host acceptance requires a clean committed DIM driver source");
  const driverSourceSha = (await runCommand("git", ["-C", sourceRoot, "rev-parse", "HEAD"])).stdout.trim();
  const writeFixtureFailure = process.env.DIM_PRACTICAL_CI_REQUIRED === "1"
    ? fixtureFailureWriter(join(dirname(configurationReportPath()), "selected-command-diagnostics.jsonl")) : undefined;
  const results = [];
  for (const profile of selected) {
    progress.phase(profile.name, "starting selected-host usability smoke");
    const observedCommands: CommandEvidence[] = [];
    let observedRuntimeVersions: OrdinaryRuntimeVersions | undefined;
    const smokeOptions = { ...(writeFixtureFailure === undefined ? {} : { writeFixtureFailure }),
      onCommand: (evidence: CommandEvidence): void => { observedCommands.push(evidence); progress.command(profile.name, evidence); },
      onRuntimeVersions: (versions: OrdinaryRuntimeVersions): void => {
        observedRuntimeVersions = versions;
        if (!input.json) process.stdout.write(`runtime-versions\t${profile.name}\tnode=${versions.node}\tkernel=${versions.kernel}\tnested-docker=${versions.nestedDocker}\n`);
      }, onProgress: (step: string, phase: "pass" | "progress" | "incomplete"): void => { progress.phase(profile.name, step, phase); } };
    try {
      const { workspace, runtimeVersions, auxiliaryVm, inference, sessionModel, monitor, lanes, commands, endpoints } = await runHostSmoke(profile, smokeOptions);
      const outcome = lanes.some((lane) => lane.status === "BLOCKED") || monitor !== null && monitorInspection(monitor) !== "inspected" ? "incomplete" : "passed";
      results.push({ host: profile.name, workspace, runtimeVersions, auxiliaryVm, inference, sessionModel, outcome, completion: "not-assessed", monitor, lanes, commands, endpoints });
      if (!input.json) for (const lane of lanes) process.stdout.write(`${lane.status}\t${profile.name}\t${lane.name}${lane.reason === undefined ? "" : `: ${lane.reason}`}\n`);
    } catch (error) {
      const step = error instanceof SmokeFailure ? error.step : "runtime-or-owned-cleanup";
      const detail = error instanceof SmokeFailure || error instanceof OperatorInputError || error instanceof AggregateError
        ? error.message : "Unexpected runtime failure; inspect private selected-host diagnostics";
      results.push({ host: profile.name, outcome: "failed", completion: "not-assessed", monitor: null, runtimeVersions: observedRuntimeVersions, commands: observedCommands, lanes: [{ name: step, status: "FAIL", reason: detail }] });
      if (!input.json) process.stderr.write(`FAIL\t${profile.name}\t${step}: ${detail}\n`);
    }
  }
  progress.phase("isolated-update", "starting isolated installation update");
  const update = configuration.isolatedUpdate === undefined
    ? { status: "BLOCKED", reason: "No reviewed isolated update facades/bundles/image supplied; installed fleet was not modified" }
    : await verifyIsolatedInstallationUpdate(configuration.isolatedUpdate).then((evidence) => ({ status: "PASS", ...evidence }), (error: unknown) => ({
      status: "FAIL", reason: error instanceof OperatorInputError || error instanceof AggregateError ? error.message : "Isolated update failed; inspect private fixture diagnostics"
    }));
  progress.phase("isolated-update", "isolated installation update finished", update.status === "PASS" ? "pass" : "incomplete");
  const outcome = results.some((result) => result.outcome === "failed") || update.status === "FAIL" ? "failed"
    : results.every((result) => result.outcome === "passed") && update.status === "PASS" ? "passed" : "incomplete";
  if (input.json) process.stdout.write(`${JSON.stringify({ outcome, completion: "not-assessed", driverSourceSha, installedSourceSha: configuration.installedSourceSha, preflights, results, isolatedUpdate: update })}\n`);
  else process.stdout.write(`driver-source\t${driverSourceSha}\n${update.status}\tisolated-installation-update\n`);
  if (outcome !== "passed") process.exitCode = 2;
}

try { await main(); }
catch (error) {
  if (process.argv.includes("--json")) {
    process.stdout.write(`${JSON.stringify({ outcome: "failed", completion: "not-assessed", error: error instanceof SmokeFailure
      ? { name: error.name, host: error.host, step: error.step }
      : { name: error instanceof OperatorInputError ? error.name : "InspectionError" } })}\n`);
    process.exitCode = 2;
  } else if (error instanceof OperatorInputError || error instanceof SmokeFailure || error instanceof SyntaxError) {
    process.stderr.write(`${error instanceof SyntaxError ? "configuration is not valid JSON" : error.message}\n`);
    process.exitCode = 2;
  } else {
    process.stderr.write("selected-host smoke failed unexpectedly; no raw command output was published\n");
    process.exitCode = 1;
  }
}
