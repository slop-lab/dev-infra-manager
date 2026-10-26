#!/usr/bin/env -S node --import tsx
import { readFile } from "node:fs/promises";
import { helpText, OperatorInputError, SmokeFailure, parseOperatorArguments, parseSmokeConfiguration } from "../../tests/scenarios/selected-host/config.js";
import { preflightHost, runHostSmoke } from "../../tests/scenarios/selected-host/scenario.js";

async function main(): Promise<void> {
  const values = process.argv.slice(2);
  if (values.length === 1 && ["--help", "-h"].includes(values[0] ?? "")) {
    process.stdout.write(`${helpText}\n`);
    return;
  }
  const input = parseOperatorArguments(values);
  const configuration = parseSmokeConfiguration(JSON.parse(await readFile(input.configPath, "utf8")));
  const selected = input.hosts.map((name) => {
    const profile = configuration.hosts.find((candidate) => candidate.name === name);
    if (profile === undefined) throw new OperatorInputError(`selected host '${name}' has no reviewed profile in ${input.configPath}`);
    return profile;
  });
  let available = true;
  const preflights: { readonly host: string; readonly ok: boolean; readonly details: readonly string[] }[] = [];
  for (const profile of selected) {
    if (!input.json) process.stdout.write(`progress\t${profile.name}\tchecking selected-host version, capabilities and ownership\n`);
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
  const results = [];
  for (const profile of selected) {
    if (!input.json) process.stdout.write(`progress\t${profile.name}\tstarting selected-host usability smoke\n`);
    const smokeOptions = input.json ? {} : { onProgress: (step: string): void => { process.stdout.write(`pass\t${profile.name}\t${step}\n`); } };
    const monitor = await runHostSmoke(profile, configuration.installedSourceSha, smokeOptions);
    results.push({ host: profile.name, outcome: "passed", completion: "not-assessed", monitor });
  }
  if (input.json) process.stdout.write(`${JSON.stringify({ outcome: "passed", completion: "not-assessed", preflights, results })}\n`);
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
