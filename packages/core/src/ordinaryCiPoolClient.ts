import { UserError } from "./errors.js";
import { ensureGitea, giteaRequest, giteaRunnerBaseUrl } from "./gitea.js";
import type { CiRunnerRegistration } from "./ciCoordinator.js";
import type { LifecycleOptions } from "./lifecycleTypes.js";
import type { OrdinaryCiPoolConnection } from "./ordinaryCiPoolConfig.js";
import type { OrdinaryPoolClaim } from "./ordinaryCiPoolWorker.js";
import { assertGiteaOrganizationIdentity, parseGiteaOrganizationIdentity } from "./project-registry/giteaOrganization.js";
import type { CommandRunner } from "./types.js";

export type OrdinaryPoolClaimResult =
  | { readonly kind: "idle" }
  | { readonly kind: "claimed"; readonly claim: OrdinaryPoolClaim }
  | { readonly kind: "recovery"; readonly claimId: string; readonly projectId: string };

export async function prepareOrdinaryPoolGiteaRunner(
  runner: CommandRunner,
  options: LifecycleOptions,
  claim: OrdinaryPoolClaim,
  expectedHostId: string
): Promise<CiRunnerRegistration> {
  const connection = await ensureGitea(runner, options);
  if (connection.kind !== "external") throw new UserError("the ordinary CI pool requires external Gitea");
  const binding = connection.projectBindings[claim.projectName];
  if (connection.hostId !== expectedHostId || binding?.id !== claim.projectId
    || binding.gitNamespace !== claim.organization || binding.giteaOrganizationId !== claim.organizationId) {
    throw new UserError("ordinary CI pool Gitea binding changed before registration");
  }
  const namespace = encodeURIComponent(claim.organization);
  const identity = await giteaRequest(connection, "GET", `/orgs/${namespace}`);
  if (!identity.ok) throw new UserError(`failed to verify CI organization identity: ${identity.status}`);
  assertGiteaOrganizationIdentity(await parseGiteaOrganizationIdentity(identity, claim.organization), claim.organizationId);
  const response = await giteaRequest(
    connection,
    "POST",
    `/orgs/${namespace}/actions/runners/registration-token`
  );
  if (!response.ok) throw new UserError(`failed to prepare CI runner registration: ${response.status}`);
  const body = await response.json() as { token?: string };
  if (!body.token) throw new UserError("CI coordinator returned an empty runner registration token");
  return {
    provider: "gitea-actions",
    instanceUrl: await giteaRunnerBaseUrl(runner, connection),
    token: body.token,
    hostId: connection.hostId
  };
}

export async function claimOrdinaryPoolJob(
  connection: OrdinaryCiPoolConnection,
  capacity: string,
  signal?: AbortSignal
): Promise<OrdinaryPoolClaimResult> {
  const response = await poolRequest(connection, "/v1/claims", {
    hostId: connection.hostId,
    capacity,
    requestId: crypto.randomUUID()
  }, signal);
  if (response.status === 204) return { kind: "idle" };
  if (response.status === 409) return { kind: "recovery", ...parseRecovery(await response.json()) };
  if (!response.ok) throw new UserError(`ordinary CI pool claim failed: ${response.status}`);
  return { kind: "claimed", claim: parseClaim(await response.json()) };
}

export async function renewOrdinaryPoolClaim(
  connection: OrdinaryCiPoolConnection,
  claim: OrdinaryPoolClaim,
  signal: AbortSignal
): Promise<number> {
  const response = await poolRequest(connection, `/v1/claims/${encodeURIComponent(claim.claimId)}/renew`, {
    hostId: connection.hostId
  }, signal);
  if (!response.ok) throw new UserError(`ordinary CI pool renewal failed: ${response.status}`);
  const value = await response.json();
  if (!isRecord(value) || Object.keys(value).length !== 1 || !Number.isSafeInteger(value.leaseMilliseconds)
    || Number(value.leaseMilliseconds) < 1) {
    throw new UserError("ordinary CI pool returned an invalid lease renewal");
  }
  return Number(value.leaseMilliseconds);
}

export async function acknowledgeOrdinaryPoolRecovery(
  connection: OrdinaryCiPoolConnection,
  capacity: string,
  claimId: string
): Promise<void> {
  const response = await poolRequest(connection, `/v1/claims/${encodeURIComponent(claimId)}/recover`, {
    hostId: connection.hostId,
    capacity
  });
  if (response.status !== 204) throw new UserError(`ordinary CI pool recovery failed: ${response.status}`);
}

export async function releaseOrdinaryPoolClaim(
  connection: OrdinaryCiPoolConnection,
  claim: OrdinaryPoolClaim
): Promise<void> {
  const response = await poolRequest(connection, `/v1/claims/${encodeURIComponent(claim.claimId)}/release`, {
    hostId: connection.hostId
  });
  if (response.status !== 204 && response.status !== 409) {
    throw new UserError(`ordinary CI pool release failed: ${response.status}`);
  }
}

function poolRequest(
  connection: OrdinaryCiPoolConnection,
  path: string,
  body: Readonly<Record<string, unknown>>,
  signal?: AbortSignal
): Promise<Response> {
  const timeout = AbortSignal.timeout(10_000);
  return fetch(`${connection.endpoint}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${connection.token}`,
      "Content-Type": "application/json",
      "X-DIM-Host": connection.hostId
    },
    body: JSON.stringify(body),
    redirect: "manual",
    signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout])
  });
}

function parseClaim(value: unknown): OrdinaryPoolClaim {
  if (!isRecord(value)) throw new UserError("ordinary CI pool returned an invalid claim");
  const fields = ["claimId", "jobId", "projectId", "projectName", "organization", "organizationId", "jobImage", "runnerLabel", "leaseMilliseconds"] as const;
  if (Object.keys(value).length !== fields.length || fields.some((field) => value[field] === undefined)
    || fields.filter((field) => field !== "jobId" && field !== "organizationId" && field !== "leaseMilliseconds")
      .some((field) => typeof value[field] !== "string")
    || !Number.isSafeInteger(value.jobId) || Number(value.jobId) <= 0
    || !Number.isSafeInteger(value.organizationId) || Number(value.organizationId) <= 0
    || !Number.isSafeInteger(value.leaseMilliseconds) || Number(value.leaseMilliseconds) <= 0) {
    throw new UserError("ordinary CI pool returned an invalid claim");
  }
  return {
    claimId: String(value.claimId), jobId: Number(value.jobId), projectId: String(value.projectId),
    projectName: String(value.projectName), organization: String(value.organization),
    organizationId: Number(value.organizationId), jobImage: String(value.jobImage), runnerLabel: String(value.runnerLabel),
    leaseMilliseconds: Number(value.leaseMilliseconds)
  };
}

function parseRecovery(value: unknown): { readonly claimId: string; readonly projectId: string } {
  if (!isRecord(value) || !isRecord(value.expiredClaim) || Object.keys(value).length !== 1
    || Object.keys(value.expiredClaim).length !== 2 || typeof value.expiredClaim.claimId !== "string"
    || typeof value.expiredClaim.projectId !== "string") {
    throw new UserError("ordinary CI pool returned an invalid recovery claim");
  }
  return { claimId: value.expiredClaim.claimId, projectId: value.expiredClaim.projectId };
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
