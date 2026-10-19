import type { StreamingCommandRunner } from "@slop-lab/dim-core";
import os from "node:os";
import path from "node:path";
import type { MirrorRouting } from "./cacheState.js";
import { ensureRegistryCache, REGISTRY_CACHE_CONTAINER, CONTROL_NETWORK, DOCKER_HUB_DIRECT_HOSTNAMES, sysboxRegistryDaemonConfig } from "./registryCache.js";
import { ensureAptCache, APT_CACHE_CONTAINER, APT_CACHE_ENDPOINT } from "./aptCache.js";

const images = {
  dockerImage: "registry@sha256:1be55279f18a2fe1a74edf2664cac61c1bea305b7b4642dab412e7affdcb3e33",
  aptImage: "sameersbn/apt-cacher-ng@sha256:58e74113cfac7e593201444648c105351cbfce7538bfb36dcafdc9479b2aefcc"
} as const;

export const hostMirrorProvider = {
  ...images,
  async ensure(runner: StreamingCommandRunner): Promise<MirrorRouting> {
    const stateRoot = path.resolve(process.env.DIM_HOST_MIRRORS_STATE_ROOT
      ?? path.join(process.env.DIM_STATE_ROOT ?? path.join(process.env.XDG_STATE_HOME ?? path.join(os.homedir(), ".local/state"), "dim"), "plugins/host-mirrors"));
    const options = { stateRoot, hostMirrorProvider: images };
    await ensureRegistryCache(runner, options);
    await ensureAptCache(runner, options);
    const endpoints = await workspaceCacheEndpoints(runner);
    return { jobFiles: [{ target: "/etc/apt/apt.conf.d/99dim-mirrors", contents: `Acquire::http::Proxy "http://${endpoints.apt.host}:${endpoints.apt.port}";\nAcquire::https::Proxy "DIRECT";\n` }], network: CONTROL_NETWORK, blockedHostnames: DOCKER_HUB_DIRECT_HOSTNAMES,
      dockerDaemonConfig: sysboxRegistryDaemonConfig(), aptEndpoint: APT_CACHE_ENDPOINT };
  }
};


export async function workspaceCacheEndpoints(runner: StreamingCommandRunner) {
  async function address(name: string, port: number) {
    const result = await runner.run("docker", ["inspect", name, "--format", `{{(index .NetworkSettings.Networks "${CONTROL_NETWORK}").IPAddress}}`]);
    const host = result.stdout.trim();
    if (result.exitCode !== 0 || !/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) || host.split(".").some((part) => Number(part) > 255)) throw new Error("owned mirror cache has no private network address");
    return { host, port };
  }
  return { registry: await address(REGISTRY_CACHE_CONTAINER, 5000), apt: await address(APT_CACHE_CONTAINER, 3142) };
}
