import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import type { AuthoritativeNativePendingDelivery } from "./authoritative-native-delivery-store.js";
import type { NativeGitBundleConfig } from "./bundle-config.js";
import { nativeImportedRootPolicySchema, parseAuthoritativeImportedRootPolicy } from "./native-imported-root-policy.js";
import type { AdmissionVerifierHttpClient, AdmissionVerifierHttpResponse } from "./ordinary-admission-http.js";

const maximumResponseBytes = 64 * 1024;
const digest = z.string().regex(/^[0-9a-f]{64}$/);
const objectId = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
const uuidV4 = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
const currentRootSchema = z.object({ importNonce: uuidV4, sequence: z.number().int().nonnegative(),
  protectedRef: z.string(), commit: objectId, tree: objectId, policyDigest: digest }).strict().readonly();
const admissionResponseSchema = z.object({ schemaVersion: z.literal(1), serviceId: z.literal("ordinary-main"),
  requestId: uuidV4, servingGenerationId: digest, admission: z.object({ schemaVersion: z.literal(1),
    admissionGeneration: uuidV4, capacityConfigDigest: digest, expiresAt: z.number().int(),
    importedRoot: z.object({ serviceId: z.literal("native-main"), servingGenerationId: digest,
      projectId: z.string(), repositoryId: z.literal("root"), currentRoot: currentRootSchema,
      policy: nativeImportedRootPolicySchema }).strict().readonly() }).strict().readonly() }).strict().readonly();

export type AuthoritativeNativeAdmissionResolver = (
  delivery: AuthoritativeNativePendingDelivery, signal: AbortSignal
) => Promise<string>;

export function createAuthoritativeNativeAdmissionResolver(options: {
  readonly dependency: Pick<NativeGitBundleConfig["ordinaryCi"], "endpoint" | "query">;
  readonly generationId: string;
  readonly httpClient: AdmissionVerifierHttpClient;
}): AuthoritativeNativeAdmissionResolver {
  const authorization = `Basic ${Buffer.from(
    `${options.dependency.query.username}:${options.dependency.query.password}`).toString("base64")}`;
  return async (delivery, signal) => {
    const event = delivery.event;
    const requestId = randomUUID();
    let response: AdmissionVerifierHttpResponse;
    try {
      response = await options.httpClient.request({ endpoint: options.dependency.endpoint, method: "POST",
        path: `/v1/projects/${event.projectId}/repositories/root/native-root-admission/discover`,
        authorization, body: JSON.stringify({ schemaVersion: 1, requestId,
          generationId: options.generationId }), signal });
    } catch (error) {
      throw new AuthoritativeNativeAdmissionResolutionError("ordinary admission discovery failed", { cause: error });
    }
    if (response.statusCode !== 200 || response.contentType !== "application/json"
      || response.cacheControl !== "no-store" || response.body.length > maximumResponseBytes) {
      throw new AuthoritativeNativeAdmissionResolutionError("ordinary admission discovery response is invalid");
    }
    let input: unknown;
    try { input = JSON.parse(response.body.toString("utf8")); }
    catch (error) {
      if (error instanceof SyntaxError) {
        throw new AuthoritativeNativeAdmissionResolutionError("ordinary admission discovery response is malformed", { cause: error });
      }
      throw error;
    }
    const parsed = admissionResponseSchema.safeParse(input);
    if (!parsed.success) {
      throw new AuthoritativeNativeAdmissionResolutionError("ordinary admission discovery response is malformed");
    }
    const discovered = parsed.data;
    let policy;
    try { policy = parseAuthoritativeImportedRootPolicy(discovered.admission.importedRoot.policy); }
    catch (error) {
      if (error instanceof Error) {
        throw new AuthoritativeNativeAdmissionResolutionError("ordinary admission policy is invalid", { cause: error });
      }
      throw error;
    }
    const imported = discovered.admission.importedRoot;
    if (discovered.requestId !== requestId || discovered.servingGenerationId !== options.generationId
      || imported.servingGenerationId !== options.generationId || imported.projectId !== event.projectId
      || imported.currentRoot.policyDigest !== delivery.policyDigest
      || createHash("sha256").update(JSON.stringify(policy)).digest("hex") !== delivery.policyDigest
      || !isDeepStrictEqual(policy, imported.policy)
      || event.repositoryId !== "root" || event.protectedRef !== imported.currentRoot.protectedRef
      || event.expectedProtectedHead !== imported.currentRoot.commit
      || event.policyRevision !== policy.policyRevision
      || event.requiredReviewRevision !== policy.requiredReviewRevision
      || event.requiredJobSetRevision !== policy.requiredJobSetRevision
      || !policy.requiredJobs.some((job) => job.name === event.jobName && job.kind === "ordinary-sysbox"
        && job.evidenceClass === event.evidenceClass)) {
      throw new AuthoritativeNativeAdmissionResolutionError("ordinary admission does not match authoritative event");
    }
    return discovered.admission.admissionGeneration;
  };
}

export class AuthoritativeNativeAdmissionResolutionError extends Error {
  readonly name = "AuthoritativeNativeAdmissionResolutionError";
}
