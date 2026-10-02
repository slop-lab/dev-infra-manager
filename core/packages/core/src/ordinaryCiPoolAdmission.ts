import { createHash } from "node:crypto";
import { UserError } from "./errors.js";
import type { OrdinaryCiPoolProject, OrdinaryCiPoolServiceConfig } from "./ordinaryCiPoolService.js";
import type { StoredOrdinaryPoolClaim } from "./ordinaryCiPoolStore.js";

export type OrdinaryCiPoolAdmission = {
  readonly admissionId: string;
  readonly jobImage: string;
  readonly runnerLabel: string;
  readonly project: OrdinaryCiPoolProject;
};

export function ordinaryCiPoolAdmissionId(
  config: Pick<OrdinaryCiPoolServiceConfig, "jobImage" | "runnerLabel">,
  project: OrdinaryCiPoolProject
): string {
  const identity = [
    "ordinary-ci-pool-admission-v1",
    project.projectId,
    project.projectName,
    project.organization,
    project.organizationId,
    config.jobImage,
    config.runnerLabel
  ];
  return createHash("sha256").update(JSON.stringify(identity)).digest("hex");
}

export function ordinaryCiPoolAdmissions(config: OrdinaryCiPoolServiceConfig): readonly OrdinaryCiPoolAdmission[] {
  return config.projects.map((project) => ({
    admissionId: ordinaryCiPoolAdmissionId(config, project),
    jobImage: config.jobImage,
    runnerLabel: config.runnerLabel,
    project
  }));
}

export function ordinaryCiPoolClaimResponse(
  claim: StoredOrdinaryPoolClaim,
  admission: OrdinaryCiPoolAdmission | undefined,
  leaseMilliseconds: number
): Readonly<Record<string, string | number>> {
  if (admission === undefined || admission.project.projectId !== claim.projectId) {
    throw new UserError("ordinary CI pool claim references an inactive operator policy");
  }
  return {
    claimId: claim.claimId,
    admissionId: admission.admissionId,
    jobId: claim.jobId,
    projectId: admission.project.projectId,
    projectName: admission.project.projectName,
    organization: admission.project.organization,
    organizationId: admission.project.organizationId,
    jobImage: admission.jobImage,
    runnerLabel: admission.runnerLabel,
    leaseMilliseconds
  };
}
