import { randomUUID } from "node:crypto";
import { request } from "node:http";
import { request as secureRequest } from "node:https";
import { parseNativeQemuHostAssignment } from "./nativeQemuAssignment.js";
export type { NativeQemuHostAssignment } from "./nativeQemuAssignment.js";
import type { NativeQemuConnection } from "./nativeQemuConnection.js";

export class NativeQemuHostClient {
  constructor(readonly connection: NativeQemuConnection, readonly capacity: string) {}
  async attest(signal: AbortSignal): Promise<void> {
    const response = record(await this.call("GET", "/v1/qemu-host-identity", undefined, signal));
    if (response.serviceId !== "qemu-main" || response.hostId !== this.connection.hostId
      || !Array.isArray(response.capacities) || !response.capacities.includes(this.capacity)) invalid();
  }
  async claim(requestId: string, signal: AbortSignal): Promise<import("./nativeQemuAssignment.js").NativeQemuHostAssignment | undefined> {
    const response = await this.call("POST", "/v1/qemu-host-claims",
      { schemaVersion: 1, requestId, capacity: this.capacity }, signal, true);
    if (response === undefined) return undefined;
    return parseNativeQemuHostAssignment(response,
      { connection: this.connection, capacity: this.capacity, requestId });
  }
  async renew(claimId: string, signal: AbortSignal): Promise<void> {
    await this.call("POST", "/v1/qemu-host-claim-renewals",
      { schemaVersion: 1, requestId: randomUUID(), claimId, capacity: this.capacity }, signal);
  }
  async candidateLease(assignment: import("./nativeQemuAssignment.js").NativeQemuHostAssignment,
    signal: AbortSignal): Promise<import("./nativeCandidateLease.js").NativeCandidateLease> {
    const claimId = assignment.claim.claimId;
    if (typeof claimId !== "string") invalid();
    const response = record(await this.call("POST", "/v1/qemu-host-candidate-leases", { schemaVersion: 1,
      requestId: randomUUID(), claimId, attemptId: assignment.attempt.attemptId,
      descriptorDigest: assignment.attempt.descriptorDigest }, signal));
    if (typeof response.username !== "string" || typeof response.password !== "string"
      || typeof response.expiresAt !== "number") invalid();
    return { username: response.username, password: response.password, expiresAt: response.expiresAt };
  }
  async report(claimId: string, terminalEvent: Readonly<Record<string, unknown>>,
    signal: AbortSignal): Promise<void> {
    await this.call("POST", "/v1/qemu-host-results",
      { schemaVersion: 1, requestId: randomUUID(), claimId, capacity: this.capacity,
        cleanupComplete: true, terminalEvent }, signal);
  }
  async recover(claimId: string, signal: AbortSignal): Promise<void> {
    await this.call("POST", "/v1/qemu-host-recoveries",
      { schemaVersion: 1, requestId: randomUUID(), claimId, capacity: this.capacity,
        cleanupComplete: true }, signal, true);
  }
  private async call(method: "GET" | "POST", path: string, body: unknown,
    signal: AbortSignal, allowEmpty = false): Promise<unknown | undefined> {
    const serialized = body === undefined ? undefined : JSON.stringify(body);
    const target = new URL(path, this.connection.scheduler.endpoint);
    return new Promise((resolve, reject) => {
      const sendRequest = target.protocol === "https:" ? secureRequest : request;
      const outgoing = sendRequest(target, { method, signal, headers: {
        authorization: `Basic ${Buffer.from(`${this.connection.hostId}:${this.connection.scheduler.hostToken}`).toString("base64")}`,
        accept: "application/json", ...(serialized === undefined ? {} : {
          "content-type": "application/json", "content-length": Buffer.byteLength(serialized)
      }) } }, (incoming) => {
        const chunks: Buffer[] = [];
        let size = 0;
        incoming.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > 256 * 1024) incoming.destroy(new NativeQemuHostClientError("native QEMU scheduler response is too large"));
          else chunks.push(chunk);
        });
        incoming.once("error", reject);
        incoming.once("end", () => {
          if (allowEmpty && incoming.statusCode === 204) { resolve(undefined); return; }
          if (incoming.statusCode === undefined || incoming.statusCode < 200 || incoming.statusCode >= 300
            || incoming.headers["cache-control"] !== "no-store") {
            reject(new NativeQemuHostClientError("native QEMU scheduler rejected the request")); return;
          }
          try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
          catch (error) { reject(new NativeQemuHostClientError("native QEMU scheduler response is invalid", { cause: error })); }
        });
      });
      outgoing.once("error", reject);
      outgoing.end(serialized);
    });
  }
}
function record(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalid();
  return Object.fromEntries(Object.keys(value).map((key) => [key, Reflect.get(value, key)]));
}
function invalid(): never { throw new NativeQemuHostClientError("native QEMU scheduler response is invalid"); }
export class NativeQemuHostClientError extends Error { readonly name = "NativeQemuHostClientError"; }
