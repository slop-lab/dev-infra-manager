import { request } from "node:http";
import { loadNativeQemuSchedulerConfig, type NativeQemuCredential,
  type NativeQemuSchedulerConfig } from "./nativeQemuSchedulerConfig.js";
import { UserError } from "@slop-lab/dim-core";

export async function queryNativeQemuEvent(eventId: string, configPath: string): Promise<unknown> {
  if (!/^[0-9a-f]{64}$/.test(eventId)) throw new UserError("native QEMU event ID is invalid");
  const config = await loadNativeQemuSchedulerConfig(configPath);
  return call(config, config.credentials.query, "GET", `/v1/qemu-events/${eventId}/status`);
}

async function call(config: NativeQemuSchedulerConfig, credential: NativeQemuCredential,
  method: "GET" | "POST", path: string): Promise<unknown> {
  const host = config.host === "0.0.0.0" ? "127.0.0.1" : config.host;
  const authorization = `Basic ${Buffer.from(`${credential.username}:${credential.password}`).toString("base64")}`;
  return new Promise<unknown>((resolve, reject) => {
    const operation = request({ host, port: config.port, method, path,
      headers: { authorization, accept: "application/json" } }, (response) => {
      const chunks: Buffer[] = [];
      let size = 0;
      response.on("data", (chunk: Buffer) => { size += chunk.length;
        if (size > 64 * 1024) operation.destroy(new UserError("native QEMU operator response is too large"));
        else chunks.push(chunk); });
      response.on("end", () => {
        const status = response.statusCode ?? 0;
        if (status < 200 || status >= 300 || response.headers["content-type"] !== "application/json"
          || response.headers["cache-control"] !== "no-store") {
          reject(new UserError(`native QEMU operator request failed with status ${status}`)); return;
        }
        try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
        catch (error) { reject(new UserError("native QEMU operator response is malformed", { cause: error })); }
      });
    });
    operation.once("error", reject);
    operation.setTimeout(5_000, () => operation.destroy(new UserError("native QEMU operator request timed out")));
    operation.end();
  });
}
