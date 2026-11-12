import type { CommandRunner } from "../types.js";
import { workspaceImageReference } from "../workspaceImageReference.js";

export interface HostCheck { name: string; ok: boolean; detail: string }
export interface WorkspaceRuntimeFailure { readonly name: string; readonly runtime: string; readonly phase: string; readonly error?: string }

const sysboxTimeNamespaceFailure = 'namespace {"time" ""} does not exist';

export function workspaceRuntimeFailureCheck(failures: readonly WorkspaceRuntimeFailure[]): HostCheck | undefined {
  const failure = failures.find(({ runtime, phase, error }) => (runtime === "container" || runtime === "container-kvm")
    && phase === "error" && error !== undefined && /^at start (?:replacement )?runtime:/.test(error)
    && error.includes(sysboxTimeNamespaceFailure));
  if (!failure) return undefined;
  return {
    name: "Sysbox startup compatibility",
    ok: false,
    detail: `workspace '${failure.name}' recorded the Sysbox startup error '${sysboxTimeNamespaceFailure}'. On an idle host, have an operator review Docker daemon configuration for features.time-namespaces=false, validate it, and restart Docker. DIM does not change daemon settings or restart services.`
  };
}

/** Inspect only base host prerequisites; never provision services or require managed plugins. */
export async function checkWorkspaceHost(
  runner: CommandRunner,
  image = workspaceImageReference(process.env.DIM_WORKSPACE_IMAGE)
): Promise<HostCheck[]> {
  const git = await runner.run("git", ["--version"]);
  const docker = await runner.run("docker", ["info", "--format", "{{json .Runtimes}}"]);
  const checks: HostCheck[] = [
    { name: "Linux runtime host", ok: process.platform === "linux", detail: process.platform },
    { name: "Git", ok: git.exitCode === 0, detail: (git.exitCode === 0 ? git.stdout : git.stderr).trim() || "Git is unavailable" },
    { name: "Docker daemon", ok: docker.exitCode === 0, detail: docker.exitCode === 0 ? "accessible" : docker.stderr.trim() || "Docker is unavailable" }
  ];
  if (docker.exitCode !== 0) return checks;
  let sysbox = false;
  try {
    const runtimes: unknown = JSON.parse(docker.stdout);
    sysbox = runtimes !== null && typeof runtimes === "object" && Object.hasOwn(runtimes, "sysbox-runc");
  } catch { /* Invalid daemon output is a failed runtime check. */ }
  checks.push({ name: "Sysbox runtime", ok: sysbox, detail: sysbox ? "registered" : "install and register sysbox-runc on this host" });
  const available = await runner.run("docker", ["image", "inspect", "--format", "{{.Id}}", image]);
  checks.push({
    name: "Workspace image", ok: available.exitCode === 0,
    detail: available.exitCode === 0 ? image : `image '${image}' is unavailable; run dim image build`
  });
  return checks;
}
