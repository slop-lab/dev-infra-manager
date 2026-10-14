import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { isIPv4 } from "node:net";

const [containerId] = process.argv.slice(2);
if (!containerId) throw new Error("agent-dind container ID is required");
const manifest = JSON.parse(readFileSync(process.env.DIM_PROJECT_MANIFEST, "utf8"));
const repository = new URL(`${manifest.gitBaseUrl}/root.git`);
if (repository.origin !== "http://127.0.0.1:19418"
  || !/^\/v1\/projects\/[a-z0-9][a-z0-9-]*\/repositories\/root\.git$/.test(repository.pathname)
  || repository.username || repository.password || repository.search || repository.hash) {
  throw new Error("custom agent requires the native workspace Git broker");
}
const docker = (...args) => JSON.parse(execFileSync("docker", args, { encoding: "utf8" }));
const [container] = docker("container", "inspect", containerId);
const endpoints = Object.entries(container.NetworkSettings.Networks);
if (endpoints.length !== 1) throw new Error("agent-dind requires exactly one private Compose network");
const [networkName, endpoint] = endpoints[0];
const [network] = docker("network", "inspect", endpoint.NetworkID);
const project = container.Config.Labels["com.docker.compose.project"];
const gateway = endpoint.Gateway;
if (!project || network.Name !== networkName || network.Driver !== "bridge" || network.Scope !== "local"
  || network.Labels["com.docker.compose.project"] !== project
  || network.Labels["com.docker.compose.network"] !== "default"
  || !isIPv4(gateway) || gateway === "0.0.0.0"
  || !network.IPAM.Config.some((entry) => entry.Gateway === gateway)) {
  throw new Error("agent Git relay requires its own Compose-default bridge gateway");
}
const attestation = JSON.parse(execFileSync("node", [
  "/usr/local/lib/dim/agent-git-relay.mjs", "ensure"
], {
  encoding: "utf8",
  env: {
    ...process.env,
    DIM_AGENT_GIT_RELAY_MODE: "native",
    DIM_AGENT_GIT_UPSTREAM: repository.origin,
    DIM_AGENT_GIT_PATH: repository.pathname,
    DIM_AGENT_GIT_LISTEN_HOST: gateway,
    DIM_AGENT_GIT_LISTEN_PORT: "19419",
    DIM_AGENT_GIT_INITIAL_PHASE: "ready"
  }
}));
if (attestation.schemaVersion !== 1 || attestation.status !== "ready"
  || attestation.host !== gateway || attestation.port !== 19419) {
  throw new Error("custom agent Git relay readiness did not match its private listener");
}
const base = `http://${gateway}:19419${repository.pathname.slice(0, -"/root.git".length)}`;
execFileSync("git", ["-C", `${process.env.DIM_WORKSPACE_DATA}/workspace`,
  "remote", "set-url", "origin", `${base}/root.git`], { stdio: ["ignore", "ignore", "inherit"] });
process.stdout.write(`${base}\n`);
