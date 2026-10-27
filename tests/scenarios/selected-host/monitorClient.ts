import { request } from "node:http";
import { request as requestHttps } from "node:https";
import type { MonitorClient } from "./monitor.ts";

export function authenticatedMonitorClient(base: string, credentials: { readonly username: string; readonly password: string }, directory: string): MonitorClient {
  const endpoint = new URL(base);
  if (!["http:", "https:"].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.pathname !== "/" || endpoint.search || endpoint.hash) {
    throw new Error("monitor endpoint must be a credential-free HTTP(S) origin");
  }
  const authorization = `Basic ${Buffer.from(`${credentials.username}:${credentials.password}`).toString("base64")}`;
  return { async get(pathname, timeoutMs) {
    const url = new URL(pathname, endpoint.origin);
    if (!pathname.startsWith("/") || pathname.startsWith("//") || url.username || url.password || url.hash || url.origin !== endpoint.origin || !/^\/(?:experimental\/tool\/ids|session(?:\/status|\/ses_[A-Za-z0-9]{1,100}(?:\/(?:message|children))?)?)$/.test(url.pathname)
      || [...url.searchParams].some(([name, value]) => name !== "limit" || !/^[1-9][0-9]{0,2}$/.test(value) || Number(value) > 200)) {
      throw new Error("monitor request must select a bounded read-only session metadata endpoint");
    }
    url.searchParams.set("directory", directory);
    const client = url.protocol === "https:" ? requestHttps : request;
    const body = await new Promise<string>((resolve, reject) => {
      const call = client(url, { method: "GET", headers: { authorization }, signal: AbortSignal.timeout(timeoutMs) }, (response) => {
        response.once("error", reject);
        const status = response.statusCode ?? 0;
        if (status < 200 || status >= 300) { response.resume(); reject(new Error(`monitor HTTP ${status}`)); return; }
        let bytes = 0, output = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          bytes += Buffer.byteLength(chunk);
          if (bytes > 2 * 1024 * 1024) call.destroy(new Error("monitor response limit")); else output += chunk;
        });
        response.once("end", () => resolve(output));
      });
      call.once("error", reject); call.end();
    });
    try { const value: unknown = JSON.parse(body); return value; }
    catch { throw new Error("monitor metadata response is not JSON"); }
  } };
}
