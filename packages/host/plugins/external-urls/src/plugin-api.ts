import type { HostPluginExtension } from "@slop-lab/dim-host-core/plugin-api";
import type { AdminRouteContext, ControllerRuntimeContext, DimPluginHost } from "@slop-lab/dim-host-core/controller";
import { EXTERNAL_URL_INGRESS_DRIVER_EXTENSION, type ExternalUrlConfig, type ExternalUrlScheme } from "@slop-lab/dim-contracts-external-url";
import type { ExternalUrlRoutePolicyConfig } from "./routePolicy.js";

export { EXTERNAL_URL_INGRESS_DRIVER_EXTENSION } from "@slop-lab/dim-contracts-external-url";
export interface ExternalUrlIngressRuntime {
  readonly scheme: ExternalUrlScheme;
  readonly domain: string;
  readonly listenHost: string;
  readonly listenPort: number;
  readonly port?: number;
  readonly routePolicy?: ExternalUrlRoutePolicyConfig;
  readonly approvalExposure?: { readonly listenHost: string; readonly listenPort: number };
  initialize?(runtime: ControllerRuntimeContext, name: string): Promise<void>;
}
export interface IngressDriverContext { readonly host: DimPluginHost; readonly config: ExternalUrlConfig }
export interface ExternalUrlIngressDriver {
  configure(scheme: ExternalUrlScheme, arguments_: readonly string[], context: IngressDriverContext): Promise<string>;
  runtime(argument: string, context: IngressDriverContext, scheme: ExternalUrlScheme): Promise<ExternalUrlIngressRuntime>;
  verify(argument: string, context: IngressDriverContext): Promise<void>;
  dependencies?(argument: string): readonly string[];
  remove?(name: string, argument: string, runtime: AdminRouteContext, context: IngressDriverContext, cleanupDns: boolean): Promise<void>;
  prune?(runtime: ControllerRuntimeContext, configuredNames: ReadonlySet<string>): Promise<void>;
}
/** Contribute an ingress driver from an independently installed host plugin. */
export function externalUrlIngressDriverExtension(name: string, driver: ExternalUrlIngressDriver): HostPluginExtension {
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(name)) throw new Error("invalid external URL ingress driver name");
  return { kind: EXTERNAL_URL_INGRESS_DRIVER_EXTENSION, name, value: driver };
}
