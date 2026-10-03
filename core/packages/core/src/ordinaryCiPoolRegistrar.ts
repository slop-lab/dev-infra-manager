import { UserError } from "./errors.js";
import { ensureGitea, giteaRequest } from "./gitea.js";
import { giteaCiCoordinator } from "./giteaCiCoordinator.js";
import { loadCiRunnerConfig } from "./ciRunnerConfig.js";
import { LifecycleState } from "./lifecycleState.js";
import { readOrdinaryCiPoolRegistrarConnection } from "./ordinaryCiPoolConfig.js";
import { resolveProtectedRootSnapshotLocked } from "./protectedRootSnapshot.js";
import { assertGiteaOrganizationIdentity, parseGiteaOrganizationIdentity } from "./project-registry/giteaOrganization.js";
import type { LifecycleOptions } from "./lifecycleTypes.js";
import type { StreamingCommandRunner } from "./types.js";

export type OrdinaryCiPoolReconciliation = {
  readonly admissionId: string;
  readonly serviceId: string;
  readonly sourceRef: string;
  readonly sourceCommit: string;
  readonly configDigest: string;
  readonly leaseMilliseconds: number;
};

export type OrdinaryCiPoolReconciliationRequest = {
  readonly projectName: string;
  readonly registrarFile: string;
};

export async function reconcileOrdinaryCiPoolProject(
  runner: StreamingCommandRunner,
  options: LifecycleOptions,
  request: OrdinaryCiPoolReconciliationRequest
): Promise<OrdinaryCiPoolReconciliation> {
  const registrar = await readOrdinaryCiPoolRegistrarConnection(request.registrarFile);
  const gitea = await ensureGitea(runner, options);
  if (gitea.kind !== "external") throw new UserError("ordinary CI pool admission requires external Gitea");
  const state = new LifecycleState(options.stateRoot);
  const release = await state.acquireProjectLock(request.projectName);
  try {
    const project = await state.readProject(request.projectName);
    const snapshot = await resolveProtectedRootSnapshotLocked({ runner, options, project, credentials: gitea });
    const binding = gitea.projectBindings[snapshot.project.name];
    if (binding === undefined || binding.id !== snapshot.project.id
      || binding.gitNamespace !== snapshot.project.gitNamespace
      || binding.giteaOrganizationId !== snapshot.project.giteaOrganizationId) {
      throw new UserError("ordinary CI pool Project does not match the reviewed external Gitea binding");
    }
    const organization = await giteaRequest(gitea, "GET", `/orgs/${encodeURIComponent(binding.gitNamespace)}`);
    if (!organization.ok) throw new UserError(`failed to verify ordinary CI organization identity: ${organization.status}`);
    assertGiteaOrganizationIdentity(
      await parseGiteaOrganizationIdentity(organization, binding.gitNamespace),
      binding.giteaOrganizationId
    );
    const reviewed = await loadCiRunnerConfig(snapshot);
    if (reviewed.config.workloads.ordinary.image !== registrar.expectedJobImage) {
      throw new UserError("reviewed ordinary CI image does not match the common pool image");
    }
    const response = await registrarRequest(registrar, "/v1/admissions", {
      projectId: snapshot.project.id,
      projectName: snapshot.project.name,
      organization: snapshot.project.gitNamespace,
      organizationId: snapshot.project.giteaOrganizationId,
      sourceRef: reviewed.provenance.sourceRef,
      sourceCommit: reviewed.provenance.sourceCommit,
      configDigest: reviewed.provenance.configDigest,
      jobImage: reviewed.config.workloads.ordinary.image,
      runnerLabels: reviewed.config.workloads.ordinary.labels
    });
    if (!response.ok) throw new UserError(`ordinary CI pool admission failed: ${response.status}`);
    const result = parseAdmissionResponse(await response.json(), registrar.expectedServiceId);
    try {
      await giteaCiCoordinator.ensureWorkflowJobWebhook(runner, options, snapshot.project, {
        url: result.webhookUrl,
        authorizationHeader: `Bearer ${result.webhookToken}`,
        central: true,
        replayQueuedJob: async (job) => {
          const replay = await registrarRequest(registrar, `/v1/admissions/${encodeURIComponent(snapshot.project.id)}/jobs`, {
            jobId: job.id,
            labels: job.labels
          });
          if (replay.status !== 202) throw new UserError(`ordinary CI pool queued-job replay failed: ${replay.status}`);
        }
      });
    } catch (error) {
      const revoked = await registrarRequest(registrar, `/v1/admissions/${encodeURIComponent(result.admissionId)}/revoke`, {
        projectId: snapshot.project.id
      });
      if (revoked.status !== 204 && revoked.status !== 409) {
        throw new UserError(`ordinary CI pool reconciliation failed and admission revocation returned ${revoked.status}`, { cause: error });
      }
      throw error;
    }
    return {
      admissionId: result.admissionId,
      serviceId: result.serviceId,
      sourceRef: reviewed.provenance.sourceRef,
      sourceCommit: reviewed.provenance.sourceCommit,
      configDigest: reviewed.provenance.configDigest,
      leaseMilliseconds: result.leaseMilliseconds
    };
  } finally {
    await release();
  }
}

type RegistrarConnection = Awaited<ReturnType<typeof readOrdinaryCiPoolRegistrarConnection>>;

function registrarRequest(connection: RegistrarConnection, path: string, body: Readonly<Record<string, unknown>>): Promise<Response> {
  return fetch(`${connection.endpoint}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${connection.token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    redirect: "manual",
    signal: AbortSignal.timeout(10_000)
  });
}

function parseAdmissionResponse(value: unknown, expectedServiceId: string): {
  readonly admissionId: string;
  readonly serviceId: string;
  readonly webhookUrl: string;
  readonly webhookToken: string;
  readonly leaseMilliseconds: number;
} {
  if (!isRecord(value) || Object.keys(value).length !== 5 || typeof value.admissionId !== "string"
    || value.serviceId !== expectedServiceId || typeof value.webhookUrl !== "string"
    || typeof value.webhookToken !== "string" || !Number.isSafeInteger(value.leaseMilliseconds)
    || Number(value.leaseMilliseconds) < 1) {
    throw new UserError("ordinary CI pool returned an invalid admission response");
  }
  return {
    admissionId: value.admissionId, serviceId: expectedServiceId, webhookUrl: value.webhookUrl,
    webhookToken: value.webhookToken, leaseMilliseconds: Number(value.leaseMilliseconds)
  };
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
