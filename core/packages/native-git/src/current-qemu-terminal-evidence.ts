import { createHash, randomUUID } from "node:crypto";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isDeepStrictEqual } from "node:util";
import type { NativeGitBundleConfig } from "./bundle-config.js";
import type { AuthoritativeNativeReviewEnvelope } from "./authoritative-native-review-schema.js";
import { NativeQemuAuthorityState } from "./native-qemu-authority-state.js";

type QemuDependency = NonNullable<NativeGitBundleConfig["qemuCi"]>;

export async function currentQemuTerminalEvidence(
  dependency: QemuDependency,
  repository: string,
  envelope: AuthoritativeNativeReviewEnvelope,
  jobName: string
): Promise<string> {
  const event = envelope.events.find((candidate) => candidate.executionKind === "qemu"
    && candidate.jobName === jobName);
  if (event === undefined) throw new CurrentQemuTerminalEvidenceError("required QEMU review event is missing");
  const state = new NativeQemuAuthorityState(repository);
  const attempt = await state.current(envelope.review.reviewId, jobName);
  const status = (await state.snapshot()).statuses.find((candidate) => candidate.attemptId === attempt?.attemptId);
  if (attempt === undefined || status === undefined || status.result !== "success") {
    throw new CurrentQemuTerminalEvidenceError("current successful QEMU evidence is missing");
  }
  const scheduler = record(await requestJson(dependency, "GET", `/v1/qemu-events/${event.eventId}/status`));
  const result = record(scheduler.result);
  if (scheduler.serviceId !== dependency.serviceId || scheduler.eventId !== event.eventId
    || scheduler.state !== "completed" || !isDeepStrictEqual(scheduler.event, event)
    || scheduler.attemptId !== attempt.attemptId || scheduler.descriptorDigest !== attempt.descriptorDigest
    || result.claimId !== scheduler.claimId || result.cleanupComplete !== true || result.result !== "success"
    || result.eventId !== status.eventId) {
    throw new CurrentQemuTerminalEvidenceError("QEMU scheduler evidence is not current and delivered");
  }
  const requestId = randomUUID();
  const admission = record(await requestJson(dependency, "POST",
    `/v1/qemu-projects/${encodeURIComponent(envelope.review.projectId)}/admission/discover`,
    { schemaVersion: 1, requestId }));
  const selected = record(admission.admission);
  if (scheduler.schemaVersion !== 1 || admission.schemaVersion !== 1
    || admission.serviceId !== dependency.serviceId || admission.requestId !== requestId
    || selected.admissionGeneration !== attempt.descriptor.admissionGeneration
    || selected.policyRevision !== envelope.review.policyRevision
    || selected.requiredJobSetRevision !== envelope.review.requiredJobSetRevision) {
    throw new CurrentQemuTerminalEvidenceError("QEMU admission evidence is not current");
  }
  return createHash("sha256").update("dim-native-qemu-promotion-evidence-v1\0")
    .update(JSON.stringify({ attempt, status, scheduler, admission })).digest("hex");
}

async function requestJson(
  dependency: QemuDependency,
  method: "GET" | "POST",
  path: string,
  body?: unknown
): Promise<unknown> {
  const target = new URL(path, dependency.endpoint);
  const serialized = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const transport = target.protocol === "https:" ? httpsRequest : httpRequest;
    const outgoing = transport(target, { method, signal: AbortSignal.timeout(5_000), headers: {
      authorization: `Basic ${Buffer.from(`${dependency.query.username}:${dependency.query.password}`).toString("base64")}`,
      accept: "application/json",
      ...(serialized === undefined ? {} : { "content-type": "application/json",
        "content-length": Buffer.byteLength(serialized) })
    } }, (incoming) => {
      const chunks: Buffer[] = [];
      let size = 0;
      incoming.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > 256 * 1024) incoming.destroy(new CurrentQemuTerminalEvidenceError("QEMU proof is too large"));
        else chunks.push(chunk);
      });
      incoming.once("error", reject);
      incoming.once("end", () => {
        if (incoming.statusCode !== 200 || incoming.headers["cache-control"] !== "no-store") {
          reject(new CurrentQemuTerminalEvidenceError("QEMU proof was rejected"));
          return;
        }
        try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
        catch (error) { reject(new CurrentQemuTerminalEvidenceError("QEMU proof is invalid", { cause: error })); }
      });
    });
    outgoing.once("error", reject);
    outgoing.end(serialized);
  });
}

function record(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new CurrentQemuTerminalEvidenceError("QEMU proof is invalid");
  }
  return Object.fromEntries(Object.keys(value).map((key) => [key, Reflect.get(value, key)]));
}

export class CurrentQemuTerminalEvidenceError extends Error {
  readonly name = "CurrentQemuTerminalEvidenceError";
}
