import {
  DIM_PLUGIN_API_VERSION,
  registerHostMirrorProvider,
  type DimPlugin,
  type HostMirrorProvider
} from "@slop-lab/dim-core";

export const hostMirrorProvider = {
  dockerImage: "registry@sha256:1be55279f18a2fe1a74edf2664cac61c1bea305b7b4642dab412e7affdcb3e33",
  aptImage: "sameersbn/apt-cacher-ng@sha256:58e74113cfac7e593201444648c105351cbfce7538bfb36dcafdc9479b2aefcc"
} as const satisfies HostMirrorProvider;

export const plugin: DimPlugin = {
  name: "@slop-lab/dim-plugin-host-mirrors",
  apiVersion: DIM_PLUGIN_API_VERSION,
  register(host) {
    registerHostMirrorProvider(host, hostMirrorProvider);
  }
};

export default plugin;
