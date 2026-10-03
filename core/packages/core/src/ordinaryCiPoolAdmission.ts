import { createHash } from "node:crypto";
import { UserError } from "./errors.js";
import type { StoredOrdinaryPoolClaim } from "./ordinaryCiPoolStore.js";

export type OrdinaryCiPoolAdmission = {
  readonly admissionId: string;
  readonly serviceId: string;
  readonly projectId: string;
  readonly projectName: string;
  readonly organization: string;
  readonly organizationId: number;
  readonly sourceRef: string;
  readonly sourceCommit: string;
  readonly configDigest: string;
  readonly jobImage: string;
  readonly runnerLabels: readonly string[];
  readonly expiresAt: number;
};

export type OrdinaryCiPoolAdmissionInput = Omit<OrdinaryCiPoolAdmission, "admissionId" | "serviceId" | "expiresAt">;

export function ordinaryCiPoolPolicyDigest(
  serviceId: string,
  input: OrdinaryCiPoolAdmissionInput
): string {
  const identity = [
    "ordinary-ci-pool-policy-v2",
    serviceId,
    input.projectId,
    input.projectName,
    input.organization,
    input.organizationId,
    input.sourceRef,
    input.sourceCommit,
    input.configDigest,
    input.jobImage,
    [...input.runnerLabels].sort()
  ];
  return createHash("sha256").update(JSON.stringify(identity)).digest("hex");
}

export function ordinaryCiPoolClaimResponse(
  claim: StoredOrdinaryPoolClaim,
  admission: OrdinaryCiPoolAdmission | undefined,
  leaseMilliseconds: number
): Readonly<Record<string, string | number | readonly string[]>> {
  if (admission === undefined || admission.projectId !== claim.projectId) {
    throw new UserError("ordinary CI pool claim references an inactive reviewed admission");
  }
  return {
    claimId: claim.claimId,
    admissionId: admission.admissionId,
    serviceId: admission.serviceId,
    jobId: claim.jobId,
    projectId: admission.projectId,
    projectName: admission.projectName,
    organization: admission.organization,
    organizationId: admission.organizationId,
    sourceRef: admission.sourceRef,
    sourceCommit: admission.sourceCommit,
    configDigest: admission.configDigest,
    jobImage: admission.jobImage,
    runnerLabels: admission.runnerLabels,
    leaseMilliseconds
  };
}
