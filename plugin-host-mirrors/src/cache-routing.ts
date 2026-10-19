/** Protocol adapters are reviewed code; placement is only a URL, never a policy program. */
export const cacheKinds = ["docker", "npm", "pypi", "apt"] as const;
export type CacheKind = typeof cacheKinds[number];
export type CacheEndpoints = Record<CacheKind, string>;
export function cacheEndpoint(input: unknown, kind: CacheKind): string {
  if (typeof input !== "string") throw new Error(`invalid ${kind} cache endpoint`);
  const value = new URL(input);
  if (!["http:", "https:"].includes(value.protocol) || value.username || value.password || value.search || value.hash
    || kind === "apt" && value.pathname !== "/") throw new Error(`invalid ${kind} cache endpoint`);
  return value.href.endsWith("/") ? value.href : `${value.href}/`;
}
export function clientFiles(endpoints: CacheEndpoints) {
  return [
    { target: "/etc/apt/apt.conf.d/99dim-mirrors", contents: `Acquire::http::Proxy "${endpoints.apt}";\nAcquire::https::Proxy "DIRECT";\n` },
    { target: "/etc/npmrc", contents: `registry=${endpoints.npm}\n` },
    { target: "/etc/pip.conf", contents: `[global]\nindex-url = ${endpoints.pypi}\n${new URL(endpoints.pypi).protocol === "http:" ? `trusted-host = ${new URL(endpoints.pypi).hostname}\n` : ""}` }
  ];
}

export interface MirrorRouting {
  readonly network: string;
  readonly dockerDaemonConfig: string;
  readonly blockedHostnames: readonly string[];
  readonly jobFiles?: readonly { readonly target: string; readonly contents: string }[];
  readonly jobEnvironmentDefaults?: Readonly<Record<string, string>>;
}
export const DOCKER_HUB_DIRECT_HOSTNAMES = ["registry-1.docker.io", "auth.docker.io"] as const;
