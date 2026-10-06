import { parseControlPlaneConfig } from "../../../../core/packages/installer/src/controlPlaneConfig.js";
import type {
  ControlPlaneDockerCommand,
  ControlPlaneDockerCommandResult,
  ControlPlaneDockerRunner
} from "../../../../core/packages/installer/src/controlPlaneDocker.js";

export const nativeImage = `registry.example/dim/native-git@sha256:${"a".repeat(64)}`;
export const ordinaryImage = `registry.example/dim/ordinary-ci@sha256:${"b".repeat(64)}`;
export const config = parseControlPlaneConfig({
  schemaVersion: 1,
  deploymentId: "main",
  nativeGit: {
    image: nativeImage,
    configFile: "/operator/native.json",
    readinessTokenFile: "/operator/native.token",
    publish: { host: "127.0.0.1", port: 7443 }
  },
  ordinaryCi: {
    image: ordinaryImage,
    configFile: "/operator/ordinary.json",
    readinessTokenFile: "/operator/ordinary.token",
    publish: { host: "127.0.0.1", port: 7410 }
  }
}, ["127.0.0.1"]);
export const snapshots = { nativeGit: "/staged/native.json", ordinaryCi: "/staged/ordinary.json" } as const;

export class AbsentRunner implements ControlPlaneDockerRunner {
  readonly calls: ControlPlaneDockerCommand[] = [];

  async run(command: ControlPlaneDockerCommand): Promise<ControlPlaneDockerCommandResult> {
    this.calls.push(command);
    return responseForAbsent(command.args);
  }
}

export class OwnedRunner extends AbsentRunner {
  override async run(command: ControlPlaneDockerCommand): Promise<ControlPlaneDockerCommandResult> {
    this.calls.push(command);
    return responseForOwned(command.args);
  }
}

export class PartialRunner extends AbsentRunner {
  override async run(command: ControlPlaneDockerCommand): Promise<ControlPlaneDockerCommandResult> {
    this.calls.push(command);
    if (command.args[0] === "network" && command.args[1] === "inspect") return ownedNetwork();
    return responseForAbsent(command.args);
  }
}

export class ForeignLabelRunner extends OwnedRunner {
  override async run(command: ControlPlaneDockerCommand): Promise<ControlPlaneDockerCommandResult> {
    this.calls.push(command);
    if (command.args[0] === "network" && command.args[1] === "inspect") {
      return ownedNetwork({ "org.dim.deployment": "foreign" });
    }
    return responseForOwned(command.args);
  }
}

export class ExtraServiceRunner extends OwnedRunner {
  override async run(command: ControlPlaneDockerCommand): Promise<ControlPlaneDockerCommandResult> {
    this.calls.push(command);
    if (isProjectList(command.args, "container")) return ok(`${"1".repeat(64)}\n${"2".repeat(64)}\n${"3".repeat(64)}\n`);
    return responseForOwned(command.args);
  }
}

export class ExtraAttachmentRunner extends OwnedRunner {
  override async run(command: ControlPlaneDockerCommand): Promise<ControlPlaneDockerCommandResult> {
    this.calls.push(command);
    if (isUserList(command.args, "network")) return ok(`${"1".repeat(64)}\n${"2".repeat(64)}\n${"3".repeat(64)}\n`);
    return responseForOwned(command.args);
  }
}

export class ExtraVolumeUserRunner extends OwnedRunner {
  override async run(command: ControlPlaneDockerCommand): Promise<ControlPlaneDockerCommandResult> {
    this.calls.push(command);
    if (isUserList(command.args, "volume") && command.args.some((arg) => arg.includes("native-git-data"))) {
      return ok(`${"1".repeat(64)}\n${"3".repeat(64)}\n`);
    }
    return responseForOwned(command.args);
  }
}

export class DigestMismatchRunner extends AbsentRunner {
  override async run(command: ControlPlaneDockerCommand): Promise<ControlPlaneDockerCommandResult> {
    this.calls.push(command);
    if (command.args[0] === "image") return imageMetadata(`registry.example/dim/native-git@sha256:${"f".repeat(64)}`, "10001:10001");
    return responseForAbsent(command.args);
  }
}

export class MalformedMetadataRunner extends AbsentRunner {
  override async run(command: ControlPlaneDockerCommand): Promise<ControlPlaneDockerCommandResult> {
    this.calls.push(command);
    if (command.args[0] === "image") return ok("not-json\n");
    return responseForAbsent(command.args);
  }
}

export class WrongUserRunner extends AbsentRunner {
  override async run(command: ControlPlaneDockerCommand): Promise<ControlPlaneDockerCommandResult> {
    this.calls.push(command);
    if (command.args[0] === "image") return imageMetadata(command.args.at(2) ?? "", "0:0");
    return responseForAbsent(command.args);
  }
}

export class FailedProbeRunner extends AbsentRunner {
  override async run(command: ControlPlaneDockerCommand): Promise<ControlPlaneDockerCommandResult> {
    this.calls.push(command);
    if (command.args[0] === "run") return { exitCode: 1, stdout: "", stderr: "invalid native-main" };
    return responseForAbsent(command.args);
  }
}

export class NoisyProbeRunner extends AbsentRunner {
  override async run(command: ControlPlaneDockerCommand): Promise<ControlPlaneDockerCommandResult> {
    this.calls.push(command);
    if (command.args[0] === "run") return ok("redirected\n");
    return responseForAbsent(command.args);
  }
}

function responseForAbsent(args: readonly string[]): ControlPlaneDockerCommandResult {
  if (args[0] === "compose") return ok("5.0.0\n");
  if (args[1] === "inspect" && args[0] === "network") return missing(`network ${args[2] ?? ""} not found`);
  if (args[1] === "inspect" && args[0] === "volume") return missing(`get ${args[2] ?? ""}: no such volume`);
  if (args[1] === "inspect" && args[0] === "container") return missing(`No such container: ${args[2] ?? ""}`);
  if (args[0] === "network" || args[0] === "volume" || args[0] === "container") return ok("");
  if (args[0] === "pull" || args[0] === "run") return ok("");
  if (args[0] === "image") return imageMetadata(args.at(2) ?? "", (args.at(2) ?? "").includes("native-git") ? "10001:10001" : "10002:10002");
  return { exitCode: 1, stdout: "", stderr: "unexpected command" };
}

function responseForOwned(args: readonly string[]): ControlPlaneDockerCommandResult {
  if (args[0] === "compose") return ok("5.0.0\n");
  if (args[0] === "network" && args[1] === "inspect") return ownedNetwork();
  if (args[0] === "volume" && args[1] === "inspect") return ownedVolume(args[2] ?? "");
  if (isProjectList(args, "network")) return ok(`${"c".repeat(64)}\n`);
  if (isProjectList(args, "volume")) return ok("dim-control-plane-native-git-data\ndim-control-plane-ordinary-ci-data\n");
  if (isProjectList(args, "container")) return ok(`${"1".repeat(64)}\n${"2".repeat(64)}\n`);
  if (isUserList(args, "network")) return ok(`${"1".repeat(64)}\n${"2".repeat(64)}\n`);
  if (isUserList(args, "volume")) return ok(`${(args.some((arg) => arg.includes("native-git-data")) ? "1" : "2").repeat(64)}\n`);
  if (args[0] === "container" && args[1] === "inspect") return ownedContainer(args[2] ?? "");
  if (args[0] === "pull" || args[0] === "run") return ok("");
  if (args[0] === "image") return imageMetadata(args.at(2) ?? "", (args.at(2) ?? "").includes("native-git") ? "10001:10001" : "10002:10002");
  return { exitCode: 1, stdout: "", stderr: "unexpected command" };
}

function ownedNetwork(overrides: Readonly<Record<string, string>> = {}): ControlPlaneDockerCommandResult {
  return ok(`${"c".repeat(64)}\nbridge\n${JSON.stringify({
    "com.docker.compose.project": "dim-control-plane", "com.docker.compose.network": "dim-control-plane",
    "org.dim.managed": "true", "org.dim.bundle": "control-plane", "org.dim.deployment": "main",
    "org.dim.resource": "network", ...overrides
  })}\n`);
}

function ownedVolume(name: string): ControlPlaneDockerCommandResult {
  const service = name.includes("native-git") ? "native-git" : "ordinary-ci";
  return ok(`${name}\nlocal\n${JSON.stringify({
    "com.docker.compose.project": "dim-control-plane", "com.docker.compose.volume": name,
    "org.dim.managed": "true", "org.dim.bundle": "control-plane", "org.dim.deployment": "main",
    "org.dim.resource": "volume", "org.dim.service": service
  })}\n`);
}

function ownedContainer(name: string): ControlPlaneDockerCommandResult {
  const service = name.includes("native-git") ? "native-git" : "ordinary-ci";
  const id = service === "native-git" ? "1".repeat(64) : "2".repeat(64);
  return ok(`${id}\n/${name}\n${JSON.stringify({
    "com.docker.compose.project": "dim-control-plane", "com.docker.compose.service": service,
    "com.docker.compose.container-number": "1", "com.docker.compose.oneoff": "False",
    "org.dim.managed": "true", "org.dim.bundle": "control-plane", "org.dim.deployment": "main",
    "org.dim.resource": "service", "org.dim.service": service
  })}\n`);
}

function imageMetadata(image: string, user: string): ControlPlaneDockerCommandResult {
  return ok(`${JSON.stringify([image])}\n${JSON.stringify(user)}\n`);
}

function isProjectList(args: readonly string[], kind: "network" | "volume" | "container"): boolean {
  return args[0] === kind && args[1] === "ls" && args.includes("label=com.docker.compose.project=dim-control-plane");
}

function isUserList(args: readonly string[], kind: "network" | "volume"): boolean {
  return args[0] === "container" && args[1] === "ls" && args.some((arg) => arg.startsWith(`${kind}=`));
}

export function serviceProbeArgs(probe: { readonly user: string; readonly image: string; readonly source: string }): readonly string[] {
  return [
    "run", "--rm", "--network", "none", "--read-only", "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges:true", "--user", probe.user,
    "--mount", `type=bind,src=${probe.source},dst=/run/secrets/service.json,readonly`,
    "--entrypoint", "/usr/local/bin/dim-service", probe.image, "check-config", "/run/secrets/service.json"
  ];
}

export function bundleProbeArgs(): readonly string[] {
  return [
    "run", "--rm", "--network", "none", "--read-only", "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges:true", "--user", "10001:10001",
    "--mount", "type=bind,src=/staged/native.json,dst=/run/native.json,readonly",
    "--mount", "type=bind,src=/staged/ordinary.json,dst=/run/ordinary.json,readonly",
    "--entrypoint", "/usr/local/bin/dim-service", nativeImage,
    "check-bundle-config", "/run/native.json", "/run/ordinary.json"
  ];
}

function ok(stdout: string): ControlPlaneDockerCommandResult {
  return { exitCode: 0, stdout, stderr: "" };
}

function missing(message: string): ControlPlaneDockerCommandResult {
  return { exitCode: 1, stdout: "\n", stderr: `Error response from daemon: ${message}\n` };
}
