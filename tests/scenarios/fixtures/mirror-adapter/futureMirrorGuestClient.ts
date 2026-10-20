import type { MirrorClientConfiguration, MirrorGuestClient } from "@slop-lab/dim-host-plugin-mirrors/adapter";

export function clientConfiguration(endpoint: string): MirrorClientConfiguration {
  return { files: [{ target: "/etc/future-mirror.conf", contents: `endpoint=${endpoint}\n` }],
    environmentDefaults: { FUTURE_MIRROR_ENDPOINT: endpoint } };
}

/** This packaging fixture supplies configuration only; it never claims a real guest installation. */
export const configureSystem: MirrorGuestClient["configureSystem"] = async () => {
  throw new Error("future adapter fixture does not install a guest client");
};
