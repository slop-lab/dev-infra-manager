import { shellQuote } from "./commands.js";
import { getRuntimePlan } from "./runtimeBackends.js";
import { formatBytes } from "./size.js";
import type { DevInfraConfig, JobMetadata, ResourceProfile } from "./types.js";

export interface AgentRunOptions {
  name?: string;
  detach?: boolean;
  remove?: boolean;
  command?: string[];
  extraEnv?: Record<string, string>;
}

export function buildAgentDockerArgs(config: DevInfraConfig, metadata: JobMetadata, options: AgentRunOptions = {}): string[] {
  const profile = metadata.resourceProfile;
  const runtimePlan = getRuntimePlan(config, metadata);
  const args = [
    "run",
    "--cpus",
    String(profile.cpuCount),
    "--memory",
    String(profile.memoryBytes),
    "--pids-limit",
    String(profile.pidsLimit)
  ];

  if (runtimePlan.dockerRuntime) {
    args.push("--runtime", runtimePlan.dockerRuntime);
  }
  for (const capability of runtimePlan.capabilities) {
    args.push("--cap-add", capability);
  }
  for (const mount of runtimePlan.mounts) {
    args.push("--mount", bindMount(mount.source, mount.target));
  }
  if (options.name) {
    args.push("--name", options.name);
  }
  if (options.detach) {
    args.push("--detach");
  }
  if (options.remove ?? true) {
    args.push("--rm");
  }

  for (const [key, value] of Object.entries({ ...runtimePlan.env, ...config.agent.env, ...config.agent.gitEnv, ...options.extraEnv })) {
    args.push("--env", `${key}=${value}`);
  }

  args.push(runtimePlan.image);
  if (options.command) {
    args.push(...options.command);
  }
  return args;
}

export function buildAgentDockerCommand(config: DevInfraConfig, metadata: JobMetadata, options: AgentRunOptions = {}): string {
  return shellQuote("docker", buildAgentDockerArgs(config, metadata, options));
}

export function buildAgentTimeoutArgs(config: DevInfraConfig, metadata: JobMetadata, options: AgentRunOptions = {}): string[] {
  return [`${metadata.resourceProfile.timeoutSeconds}s`, "docker", ...buildAgentDockerArgs(config, metadata, options)];
}

export function buildAgentTimeoutCommand(config: DevInfraConfig, metadata: JobMetadata, options: AgentRunOptions = {}): string {
  return shellQuote("timeout", buildAgentTimeoutArgs(config, metadata, options));
}

export function resourceSummary(profile: ResourceProfile): string {
  return `cpu=${profile.cpuCount} memory=${formatBytes(profile.memoryBytes)} pids=${profile.pidsLimit} disk=${formatBytes(profile.diskBytes)} timeout=${profile.timeoutSeconds}s`;
}

function bindMount(source: string, target: string): string {
  return `type=bind,source=${source},target=${target}`;
}
