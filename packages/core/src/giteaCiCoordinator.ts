import { UserError } from "./errors.js";
import { ensureGitea, giteaRequest } from "./gitea.js";
import type { CiCoordinator, CiRunnerRegistration } from "./ciCoordinator.js";

export const giteaCiCoordinator: CiCoordinator = {
  async prepareRunner(runner, options, project): Promise<CiRunnerRegistration> {
    const credentials = await ensureGitea(runner, options);
    const response = await giteaRequest(
      options,
      credentials,
      "POST",
      `/repos/${project.gitNamespace}/${project.rootRepositoryAlias}/actions/runners/registration-token`
    );
    if (!response.ok) throw new UserError(`failed to prepare CI runner registration: ${response.status}`);
    const body = await response.json() as { token?: string };
    if (!body.token) throw new UserError("CI coordinator returned an empty runner registration token");
    return {
      provider: "gitea-actions",
      instanceUrl: "http://dim-gitea:3000",
      token: body.token
    };
  },
  async removeRunner(runner, options, project, runnerName): Promise<void> {
    const credentials = await ensureGitea(runner, options);
    const base = `/repos/${project.gitNamespace}/${project.rootRepositoryAlias}/actions/runners`;
    const response = await giteaRequest(options, credentials, "GET", base);
    if (!response.ok) throw new UserError(`failed to list CI coordinator runners: ${response.status}`);
    const body = await response.json() as { runners?: Array<{ id: number; name: string }> };
    for (const candidate of body.runners ?? []) {
      if (candidate.name !== runnerName) continue;
      const removed = await giteaRequest(options, credentials, "DELETE", `${base}/${candidate.id}`);
      if (!removed.ok && removed.status !== 404) {
        throw new UserError(`failed to remove CI coordinator runner '${runnerName}': ${removed.status}`);
      }
    }
  }
};
