import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { request, type RequestOptions } from "node:https";
import type { ClientRequest, IncomingMessage } from "node:http";

const denied = new BlockList();
// Conservative exclusions include private, shared, documentation and transition ranges.
for (const [address, bits] of [["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4]] as const) denied.addSubnet(address, bits, "ipv4");
for (const [address, bits] of [["2001::", 23], ["2001:db8::", 32], ["2002::", 16], ["3fff::", 20]] as const) denied.addSubnet(address, bits, "ipv6");
const globalV6 = new BlockList(); globalV6.addSubnet("2000::", 3, "ipv6");
export function publicGitAddress(address: string): boolean {
  const family = isIP(address);
  return family === 4 ? !denied.check(address, "ipv4") : family === 6 && globalV6.check(address, "ipv6") && !denied.check(address, "ipv6");
}
export function publicGitUrl(value: string): URL {
  if (typeof value !== "string" || value.length > 2048 || !/^https:\/\/[^/]/i.test(value) || value.includes("?") || value.includes("#") || /^https:\/\/[^/]*@/i.test(value) || /[\s\x00-\x1f\x7f\\]/.test(value)) throw new Error("public Git source must be an HTTPS repository URL");
  const url = new URL(value), host = url.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.port && url.port !== "443"
    || host === "localhost" || /\.(?:localhost|local|internal|onion|invalid|test)$/.test(host) || !host.includes(".") && !isIP(host)
    || isIP(host) && !publicGitAddress(host)) throw new Error("public Git source requires a public HTTPS origin on port 443 without credentials, query or fragment");
  return url;
}
export function publicGitBranch(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$/.test(value) || value.includes("..") || value.includes("//") || value.endsWith("/")
    || value.split("/").some((part) => part.startsWith(".") || part.endsWith(".") || part.endsWith(".lock"))) throw new Error("public Git source requires a plain branch name");
  return value;
}
/** Trusted server/test injection; never accepted from a repository or browser configuration. */
export interface PublicGitDependencies {
  readonly lookup?: (hostname: string) => Promise<readonly { address: string; family: number }[]>;
  readonly request?: (options: RequestOptions, callback: (response: IncomingMessage) => void) => ClientRequest;
  readonly maximumBytes?: number;
  readonly deadlineMilliseconds?: number;
}
export const publicGitLookup = (hostname: string) => lookup(hostname, { all: true, verbatim: true });
export const publicGitRequest = request;
export function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(new Error("public Git acquisition was cancelled or exceeded its deadline"));
    signal.addEventListener("abort", abort, { once: true });
    void promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}
