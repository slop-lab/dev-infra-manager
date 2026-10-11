import type { ControlPlaneDockerCommandResult } from "../../../../core/packages/installer/src/controlPlaneDocker.js";

export function ownedNetwork(foreign = false): ControlPlaneDockerCommandResult {
  return ok(`${"c".repeat(64)}\nbridge\n${JSON.stringify({
    ...labels("network"),
    ...(foreign ? { "org.dim.deployment": "foreign" } : {})
  })}\n`);
}

export function ownedVolume(name: string, foreign = false): ControlPlaneDockerCommandResult {
  const service = name.includes("native-git") ? "native-git" : "ordinary-ci";
  return ok(`${name}\nlocal\n${JSON.stringify({
    ...labels("volume", service),
    ...(foreign ? { "org.dim.deployment": "foreign" } : {}),
    "com.docker.compose.volume": name
  })}\n`);
}

export function ownedContainer(service: "native-git" | "ordinary-ci"): ControlPlaneDockerCommandResult {
  const id = service === "native-git" ? "1".repeat(64) : "2".repeat(64);
  return ok(`${id}\n/dim-control-plane-${service}-1\n${JSON.stringify({
    ...labels("service", service),
    "com.docker.compose.service": service,
    "com.docker.compose.container-number": "1",
    "com.docker.compose.oneoff": "False"
  })}\n`);
}

function labels(resource: "network" | "volume" | "service", service?: "native-git" | "ordinary-ci"): Readonly<Record<string, string>> {
  return {
    "com.docker.compose.project": "dim-control-plane",
    ...(resource === "network" ? { "com.docker.compose.network": "dim-control-plane" } : {}),
    "org.dim.managed": "true",
    "org.dim.bundle": "control-plane",
    "org.dim.deployment": "main",
    "org.dim.resource": resource,
    ...(service === undefined ? {} : { "org.dim.service": service })
  };
}

function ok(stdout: string): ControlPlaneDockerCommandResult {
  return { exitCode: 0, stdout, stderr: "" };
}
