import type { HostPluginExtension } from "@slop-lab/dim-host-core/workspace";

export interface MirrorClientConfiguration {
  readonly files: readonly { readonly target: string; readonly contents: string }[];
  readonly environmentDefaults?: Readonly<Record<string, string>>;
  readonly dockerDaemonConfig?: string;
  readonly blockedHostnames?: readonly string[];
}
/** Copied guest modules import this interface with `import type` only. */
export interface MirrorGuestClient {
  clientConfiguration(endpoint: string): MirrorClientConfiguration;
  retiredClientConfiguration?(endpoint: string): MirrorClientConfiguration;
  configureUser?(endpoint: string): Promise<void>;
  configureSystem(endpoint: string): Promise<void>;
  removeUser?(endpoint: string): Promise<void>;
  removeSystem?(endpoint: string): Promise<void>;
}
export interface MirrorMetadataContext {
  readonly upstream: URL;
  readonly endpoint: string;
  readonly clientOrigin: string;
}
/** Trusted installed code owns one protocol, including its self-contained guest client. */
export interface MirrorAdapter {
  readonly kind: string;
  readonly description: string;
  readonly commands: readonly { readonly name: string; readonly description: string }[];
  readonly guestModuleUrl: string;
  normalizeEndpoint(value: unknown): string;
  target(path: string, endpoint: string): URL | undefined;
  requestPath?(target: URL): string;
  readonly responseHeaders?: readonly string[];
  readonly metadata?: {
    accepts(contentType: string): boolean;
    rewrite(contents: string, context: MirrorMetadataContext): string;
  };
  clientConfiguration(endpoint: string): MirrorClientConfiguration;
}
export interface MirrorAdapterModule { readonly kind: string; readonly moduleUrl: string }
export const MIRROR_ADAPTER_EXTENSION = "dim.mirror-adapter";
export function mirrorAdapterExtension(kind: string, moduleUrl: string | URL): HostPluginExtension {
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(kind)) throw new Error("invalid mirror adapter kind");
  const url = new URL(String(moduleUrl));
  if (url.protocol !== "file:" || url.hostname || url.search || url.hash) throw new Error("mirror adapter must be an installed local module");
  return { kind: MIRROR_ADAPTER_EXTENSION, name: kind, value: { moduleUrl: url.href } };
}
export function cacheEndpoint(input: unknown): string {
  if (typeof input !== "string") throw new Error("cache endpoint must be a URL");
  const url = new URL(input);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error("invalid cache endpoint");
  return url.href.endsWith("/") ? url.href : `${url.href}/`;
}
