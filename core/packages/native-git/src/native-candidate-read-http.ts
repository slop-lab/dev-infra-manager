import { randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { serveGitBackend } from "./backend.js";
import { deriveAuthoritativeQemuExecutionDescriptor } from "./authoritative-qemu-execution-descriptor.js";
import type { AuthoritativeNativeCandidateRuntime } from "./authoritative-native-root-target.js";
import { resolveAuthoritativeNativeRootTarget } from "./authoritative-native-root-target.js";
import type { NativeGitBundleConfig } from "./bundle-config.js";
import { CandidateExecutionError } from "./candidate-execution-schema.js";
import { nativeBasicAuthorized, nativeBasicCredential } from "./native-basic-auth.js";
import {
  NativeGitBundleHttpError,
  readBoundedJson,
  sendEmpty,
  sendJson,
  sendNotFound
} from "./native-bundle-http.js";
import { currentAttemptProof } from "./native-current-attempt-proof.js";
import {
  NativeImportedRootInactiveError,
  NativeImportedRootNotFoundError
} from "./native-imported-root-verifier.js";
import { NativeProjectRootImportStateError } from "./native-project-root-import-codec.js";
import { NativeQemuAuthorityState } from "./native-qemu-authority-state.js";
import type { NativeGitRoute } from "./routing.js";

const leaseLifetimeMilliseconds = 30_000;
const requestSchema = z.object({
  schemaVersion: z.literal(1),
  requestId: z.string().uuid(),
  executionKind: z.enum(["ordinary-sysbox", "qemu"]),
  projectId: z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/),
  reviewId: z.string().regex(/^[0-9a-f]{64}$/),
  jobName: z.string().regex(/^[a-z][a-z0-9-]{0,62}$/),
  attemptId: z.string().uuid(),
  descriptorDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  hostId: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,127}$/),
  capacity: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,127}$/)
}).strict().readonly();

type CandidateLeaseRequest = z.infer<typeof requestSchema>;
type CandidateLease = CandidateLeaseRequest & {
  readonly username: string;
  readonly password: string;
  readonly expiresAt: number;
  readonly repositoryId: string;
  readonly descriptor: Readonly<Record<string, unknown>>;
};

export type NativeCandidateReadService = {
  readonly close: () => void;
  readonly handleLeaseRequest: (request: IncomingMessage, response: ServerResponse, url: URL) => Promise<boolean>;
  readonly serveGit: (request: IncomingMessage, response: ServerResponse, route: NativeGitRoute) => Promise<boolean>;
};

export function createNativeCandidateReadService(input: {
  readonly config: NativeGitBundleConfig;
  readonly runtime: AuthoritativeNativeCandidateRuntime;
  readonly gitExecutable: string;
  readonly stateDirectory: string;
  readonly now: () => number;
  readonly serialize: <Result>(operation: () => Promise<Result>) => Promise<Result>;
}): NativeCandidateReadService {
  const leases = new Map<string, CandidateLease>();
  const credentials = [input.config.ordinaryCi.candidateReader,
    ...(input.config.qemuCi === undefined ? [] : [input.config.qemuCi.candidateReader])];
  const prune = (): void => {
    for (const [username, lease] of leases) if (input.now() >= lease.expiresAt) leases.delete(username);
  };
  return {
    close: () => leases.clear(),
    async handleLeaseRequest(request, response, url) {
      if (url.pathname !== "/v1/candidate-read-leases") return false;
      if (request.method !== "POST" || url.search !== "") { sendNotFound(response); return true; }
      let rawBody: unknown;
      try {
        rawBody = await readBoundedJson(request);
      } catch (error) {
        if (error instanceof NativeGitBundleHttpError) {
          sendJson(response, 400, { error: "candidate lease request is invalid" });
          return true;
        }
        throw error;
      }
      const body = requestSchema.safeParse(rawBody);
      if (!body.success) { sendJson(response, 400, { error: "candidate lease request is invalid" }); return true; }
      const credential = body.data.executionKind === "ordinary-sysbox"
        ? input.config.ordinaryCi.candidateReader : input.config.qemuCi?.candidateReader;
      if (credential === undefined || !nativeBasicAuthorized(request, credential)) {
        const known = credentials.some((candidate) => nativeBasicAuthorized(request, candidate));
        sendJson(response, known ? 403 : 401, { error: known ? "forbidden" : "unauthorized" });
        return true;
      }
      const descriptor = await input.serialize(() => currentDescriptor(input.runtime, body.data));
      if (descriptor === "conflict") {
        sendJson(response, 409, { error: "candidate authority tuple is stale" });
        return true;
      }
      if (descriptor === undefined) { sendNotFound(response); return true; }
      prune();
      const username = `candidate-${randomBytes(18).toString("hex")}`;
      const password = randomBytes(32).toString("base64url");
      const lease = { ...body.data, username, password, expiresAt: input.now() + leaseLifetimeMilliseconds,
        repositoryId: "root", descriptor };
      leases.set(username, lease);
      sendJson(response, 201, { schemaVersion: 1, serviceId: "native-main", requestId: lease.requestId,
        username, password, expiresAt: lease.expiresAt });
      return true;
    },
    async serveGit(request, response, route) {
      const supplied = nativeBasicCredential(request);
      if (supplied === undefined) return false;
      prune();
      const lease = leases.get(supplied.username);
      if (lease === undefined) return false;
      if (!safeEqual(supplied.password, lease.password)) { sendEmpty(response, 401); return true; }
      if (route.operation !== "read") { sendEmpty(response, 403); return true; }
      if (route.projectId !== lease.projectId || route.repositoryId !== lease.repositoryId) {
        sendNotFound(response); return true;
      }
      const descriptor = await input.serialize(() => currentDescriptor(input.runtime, lease));
      if (descriptor === undefined || descriptor === "conflict" || !isDeepStrictEqual(descriptor, lease.descriptor)) {
        sendNotFound(response); return true;
      }
      await serveGitBackend({ config: { gitExecutable: input.gitExecutable, storageRoot: input.stateDirectory },
        identity: { role: "reader", username: "candidate-read-lease" }, route, request, response });
      return true;
    }
  };
}

async function currentDescriptor(runtime: AuthoritativeNativeCandidateRuntime,
  selector: CandidateLeaseRequest): Promise<Readonly<Record<string, unknown>> | "conflict" | undefined> {
  try {
    if (selector.executionKind === "ordinary-sysbox") {
      const proof = await currentAttemptProof(runtime, selector.projectId, { schemaVersion: 1,
        requestId: selector.requestId, reviewId: selector.reviewId, executionKind: "ordinary-sysbox",
        jobName: selector.jobName, attemptId: selector.attemptId });
      if (proof === undefined || proof === "conflict") return proof;
      const assignment = record(proof.assignment);
      const descriptor = record(assignment.descriptor);
      return assignment.descriptorDigest === selector.descriptorDigest
        && assignment.hostId === selector.hostId && assignment.capacity === selector.capacity ? descriptor : "conflict";
    }
    const target = await resolveAuthoritativeNativeRootTarget(runtime, { projectId: selector.projectId });
    const current = await new NativeQemuAuthorityState(target.repository).current(selector.reviewId, selector.jobName);
    if (current === undefined) return undefined;
    if (current.attemptId !== selector.attemptId || current.descriptorDigest !== selector.descriptorDigest
      || current.hostId !== selector.hostId || current.capacity !== selector.capacity) return "conflict";
    const descriptor = current.descriptor;
    const execution = await deriveAuthoritativeQemuExecutionDescriptor(runtime, { projectId: selector.projectId,
      reviewId: selector.reviewId, jobName: selector.jobName, trustedCapacity: {
        admissionGeneration: descriptor.admissionGeneration, jobBaseImage: descriptor.jobImage,
        runnerBaseImage: descriptor.runnerBaseImage, bounds: descriptor.bounds } });
    return execution.digest === selector.descriptorDigest && isDeepStrictEqual(execution.descriptor, descriptor)
      ? descriptor : "conflict";
  } catch (error) {
    const disposition = candidateExecutionDisposition(error);
    if (disposition === "not-found") return undefined;
    if (disposition === "conflict") return disposition;
    throw error;
  }
}

function candidateExecutionDisposition(error: unknown): "not-found" | "conflict" | undefined {
  if (!(error instanceof CandidateExecutionError)) return undefined;
  if (error.message === "authoritative native Project is not registered"
    || error.message === "authoritative execution review was not found"
    || error.cause instanceof NativeImportedRootNotFoundError) return "not-found";
  if (error.cause instanceof NativeImportedRootInactiveError
    || error.cause instanceof NativeProjectRootImportStateError) return "conflict";
  if (error.message === "authoritative native root target could not be resolved"
    || error.message === "authoritative ordinary execution descriptor could not be derived"
    || error.message === "authoritative QEMU execution descriptor could not be derived"
    || error.message === "authoritative native candidate job inputs could not be loaded") return undefined;
  return "conflict";
}

function record(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.keys(value).map((key) => [key, Reflect.get(value, key)])) : {};
}

function safeEqual(actual: string, expected: string): boolean {
  const left = Buffer.from(actual); const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}
