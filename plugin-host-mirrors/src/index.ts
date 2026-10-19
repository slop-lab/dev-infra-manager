import type { StreamingCommandRunner } from "@slop-lab/dim-core";
import os from "node:os";
import path from "node:path";
import type { MirrorRouting } from "./cacheState.js";
import { ensureRegistryCache, CONTROL_NETWORK, DOCKER_HUB_DIRECT_HOSTNAMES, sysboxRegistryDaemonConfig } from "./registryCache.js";
import { ensureAptCache, APT_CACHE_ENDPOINT } from "./aptCache.js";

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
    return { network: CONTROL_NETWORK, blockedHostnames: DOCKER_HUB_DIRECT_HOSTNAMES,
      dockerDaemonConfig: sysboxRegistryDaemonConfig(), aptEndpoint: APT_CACHE_ENDPOINT };
  }
};

export const plugin = {
  name: "@slop-lab/dim-plugin-host-mirrors",
  apiVersion: 4 as const,
  register(host: { registerExtension(kind: string, name: string, extension: object): void }) {
    host.registerExtension("dim.host-mirror-provider", "host", hostMirrorProvider);
  }
};

export default plugin;
