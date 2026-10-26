import { access } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runCommand } from "./process.js";

export type OperatorArguments = {
  readonly image: string;
  readonly chromium: string;
  readonly preflightOnly: boolean;
  readonly connectionOnly: boolean;
};

export type PreflightCheck = {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
};

export type PreflightSummary = {
  readonly ok: boolean;
  readonly message: string;
};

export class OperatorInputError extends Error {
  readonly name = "OperatorInputError";
}

export function parseOperatorArguments(values: readonly string[]): OperatorArguments {
  const image = values[0];
  const chromiumFlag = values.indexOf("--chromium");
  const chromium = chromiumFlag < 0 ? process.env.DIM_CHROMIUM : values[chromiumFlag + 1];
  if (image === undefined || image.startsWith("--")) {
    throw new OperatorInputError("usage: web-workspace-lifecycle.ts IMAGE --chromium /absolute/path [--preflight-only|--connection-only]");
  }
  if (chromium === undefined || !path.isAbsolute(chromium)) {
    throw new OperatorInputError("--chromium or DIM_CHROMIUM must select an absolute reviewed Chromium executable");
  }
  const known = new Set([image, "--chromium", chromium, "--preflight-only", "--connection-only"]);
  const unknown = values.filter((value) => !known.has(value));
  if (unknown.length > 0) throw new OperatorInputError(`unknown argument: ${unknown[0]}`);
  const preflightOnly = values.includes("--preflight-only"), connectionOnly = values.includes("--connection-only");
  if (preflightOnly && connectionOnly) throw new OperatorInputError("choose either --preflight-only or --connection-only");
  return { image, chromium, preflightOnly, connectionOnly };
}

export function summarizePreflight(checks: readonly PreflightCheck[]): PreflightSummary {
  const failed = checks.filter((check) => !check.ok);
  return failed.length === 0
    ? { ok: true, message: "all required runtime and browser prerequisites are available" }
    : { ok: false, message: `preflight stopped before any workspace is created: ${failed.map((check) => `${check.name}: ${check.detail}`).join("; ")}` };
}

export async function inspectPrerequisites(input: OperatorArguments): Promise<readonly PreflightCheck[]> {
  const checks: PreflightCheck[] = [];
  checks.push({ name: "linux", ok: process.platform === "linux", detail: process.platform });
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  checks.push({ name: "node", ok: nodeMajor === 24 || nodeMajor === 26, detail: process.versions.node });
  if (!input.connectionOnly) {
    const docker = await runCommand("docker", ["info", "--format", "{{json .}}"], { acceptFailure: true });
    checks.push({ name: "docker", ok: docker.exitCode === 0, detail: docker.exitCode === 0 ? "daemon reachable" : "daemon is unreachable or access is denied" });
    let sysbox = false;
    if (docker.exitCode === 0) {
      const runtimes = await runCommand("docker", ["info", "--format", "{{json .Runtimes}}"], { acceptFailure: true });
      sysbox = runtimes.exitCode === 0 && /"sysbox-runc"\s*:/.test(runtimes.stdout);
    }
    checks.push({ name: "sysbox-runc", ok: sysbox, detail: sysbox ? "listed by Docker" : "not listed by Docker; install Sysbox on this disposable runtime host" });
    let cgroupV2 = false;
    try {
      await access("/sys/fs/cgroup/cgroup.controllers", constants.R_OK);
      cgroupV2 = true;
    } catch (error) {
      if (!(error instanceof Error)) throw error;
    }
    checks.push({ name: "cgroup-v2", ok: cgroupV2, detail: cgroupV2 ? "unified hierarchy available" : "cgroup v2 controllers are unavailable" });
    const image = await runCommand("docker", ["image", "inspect", input.image], { acceptFailure: true });
    checks.push({ name: "image", ok: image.exitCode === 0, detail: image.exitCode === 0 ? input.image : "selected image is not already present; this gate never pulls or builds" });
  }
  let chromiumDetail = "not executable";
  let chromiumReady = false;
  try {
    await access(input.chromium, constants.X_OK);
    chromiumReady = true;
    chromiumDetail = "absolute reviewed executable is available";
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    chromiumDetail = "absolute executable is unavailable";
  }
  checks.push({ name: "chromium", ok: chromiumReady, detail: chromiumDetail });
  const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
  const artifacts = [
    path.join(repositoryRoot, "packages/cli/core/dist/cli.js"),
    path.join(repositoryRoot, "packages/host/core/dist/application/host-main.js")
  ];
  let artifactsReady = true;
  try {
    await Promise.all(artifacts.map((artifact) => access(artifact, constants.R_OK)));
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    artifactsReady = false;
  }
  checks.push({ name: "built-artifacts", ok: artifactsReady, detail: artifactsReady ? "built CLI and host entry are readable" : "run the reviewed package build before this gate" });
  return checks;
}
