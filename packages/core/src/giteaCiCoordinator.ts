import { UserError } from "./errors.js";
import { ensureGitea, giteaNestedBaseUrl, giteaRequest } from "./gitea.js";
import type { CiCoordinator, CiRunnerRegistration } from "./ciCoordinator.js";
import type { ProjectRecord } from "./lifecycleTypes.js";

export function giteaCiRunnerApiBase(project: Pick<ProjectRecord, "gitNamespace">): string {
  return `/orgs/${encodeURIComponent(project.gitNamespace)}/actions/runners`;
}

function giteaOrgHooksApiBase(project: Pick<ProjectRecord, "gitNamespace">): string {
  return `/orgs/${encodeURIComponent(project.gitNamespace)}/hooks`;
}

async function removeNamedHook(credentials: Awaited<ReturnType<typeof ensureGitea>>, project: ProjectRecord, name: string): Promise<void> {
  const base = giteaOrgHooksApiBase(project);
  const response = await giteaRequest(credentials, "GET", base);
  if (!response.ok) throw new UserError(`failed to list CI coordinator webhooks: ${response.status}`);
  const hooks = await response.json() as Array<{ id: number; name?: string; config?: { url?: string } }>;
  const expectedUrl = `http://dim-ci-${project.name}-qemu-supervisor:8080/workflow-job`;
  for (const hook of hooks) {
    if (hook.name !== name && hook.config?.url !== expectedUrl) continue;
    const removed = await giteaRequest(credentials, "DELETE", `${base}/${hook.id}`);
    if (!removed.ok && removed.status !== 404) throw new UserError(`failed to remove CI coordinator webhook '${name}': ${removed.status}`);
  }
}

export const giteaCiCoordinator: CiCoordinator = {
  async prepareRunner(runner, options, project): Promise<CiRunnerRegistration> {
    const credentials = await ensureGitea(runner, options);
    const base = giteaCiRunnerApiBase(project);
    const response = await giteaRequest(
      credentials,
      "POST",
      `${base}/registration-token`
    );
    if (!response.ok) throw new UserError(`failed to prepare CI runner registration: ${response.status}`);
    const body = await response.json() as { token?: string };
    if (!body.token) throw new UserError("CI coordinator returned an empty runner registration token");
    return {
      provider: "gitea-actions",
      instanceUrl: await giteaNestedBaseUrl(runner),
      token: body.token
    };
  },
  async removeRunner(runner, options, project, runnerName): Promise<void> {
    const credentials = await ensureGitea(runner, options);
    const base = giteaCiRunnerApiBase(project);
    const response = await giteaRequest(credentials, "GET", base);
    if (!response.ok) throw new UserError(`failed to list CI coordinator runners: ${response.status}`);
    const body = await response.json() as { runners?: Array<{ id: number; name: string }> };
    for (const candidate of body.runners ?? []) {
      if (candidate.name !== runnerName) continue;
      const removed = await giteaRequest(credentials, "DELETE", `${base}/${candidate.id}`);
      if (!removed.ok && removed.status !== 404) {
        throw new UserError(`failed to remove CI coordinator runner '${runnerName}': ${removed.status}`);
      }
    }
  },
  async ensureWorkflowJobWebhook(runner, options, project, input): Promise<void> {
    const credentials = await ensureGitea(runner, options);
    await removeNamedHook(credentials, project, input.name);
    const response = await giteaRequest(credentials, "POST", giteaOrgHooksApiBase(project), {
      type: "gitea",
      active: true,
      events: ["workflow_job"],
      authorization_header: input.authorizationHeader,
      config: { url: input.url, content_type: "json" }
    });
    if (!response.ok) throw new UserError(`failed to create CI coordinator webhook: ${response.status}`);
  },
  async removeWorkflowJobWebhook(runner, options, project, name): Promise<void> {
    await removeNamedHook(await ensureGitea(runner, options), project, name);
  }
};
