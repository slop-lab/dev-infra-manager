import { UserError } from "./errors.js";
import { ensureGitea, giteaNestedBaseUrl, giteaRequest } from "./gitea.js";
import type { CiCoordinator, CiRunnerRegistration } from "./ciCoordinator.js";
import type { ProjectRecord } from "./lifecycleTypes.js";

export function giteaCiRunnerApiBase(project: Pick<ProjectRecord, "gitNamespace">): string {
  return `/orgs/${encodeURIComponent(project.gitNamespace)}/actions/runners`;
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
  }
};
