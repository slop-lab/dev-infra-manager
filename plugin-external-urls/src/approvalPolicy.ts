import { createHash } from "node:crypto";
import type { ExternalUrlRoutePolicyConfig } from "./routePolicy.js";

export interface ApprovalPolicyIngress {
  readonly scheme: "http" | "https" | "tcp";
  readonly domain: string;
  readonly port?: number;
  readonly listenHost: string;
  readonly listenPort: number;
  readonly upstreamMode?: "container-dns" | "container-ip";
  readonly routePolicy?: ExternalUrlRoutePolicyConfig;
  readonly approvalRequired?: boolean;
  readonly approvalExposure?: {
    readonly listenHost: string;
    readonly listenPort: number;
  };
}

export function ingressPolicyRevision(name: string, ingress: ApprovalPolicyIngress): string {
  const exposure = ingress.approvalExposure ?? ingress;
  return createHash("sha256").update(JSON.stringify({
    name,
    scheme: ingress.scheme,
    domain: ingress.domain.toLowerCase().replace(/^\.+|\.+$/g, ""),
    port: ingress.port,
    listenHost: exposure.listenHost,
    listenPort: exposure.listenPort,
    upstreamMode: ingress.upstreamMode ?? "container-ip",
    routePolicy: ingress.routePolicy ?? { driver: "workspace-prefix" },
    approvalRequired: ingress.approvalRequired === true
  })).digest("hex");
}
