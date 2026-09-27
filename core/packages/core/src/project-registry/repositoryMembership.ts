import { giteaRequest } from "../gitea.js";
import type { GiteaConnection } from "../gitea.js";
import { apiError } from "./helpers.js";

const repositoryUsers = (credentials: GiteaConnection) => [
  ["writer", credentials.writerUsername],
  ["host maintainer", credentials.maintainerUsername]
] as const;

export async function grantRepositoryUsers(
  credentials: GiteaConnection,
  organization: string,
  alias: string
): Promise<void> {
  for (const [role, username] of repositoryUsers(credentials)) {
    const response = await giteaRequest(
      credentials,
      "PUT",
      `/repos/${organization}/${alias}/collaborators/${username}`,
      { permission: "write" }
    );
    if (!response.ok && response.status !== 204) {
      throw await apiError(`grant ${role} access to '${organization}/${alias}'`, response);
    }
  }
}

export async function grantRepositoryTransferUser(
  credentials: GiteaConnection,
  organization: string,
  alias: string
): Promise<void> {
  const response = await giteaRequest(
    credentials,
    "PUT",
    `/repos/${organization}/${alias}/collaborators/${credentials.maintainerUsername}`,
    { permission: "write" }
  );
  if (!response.ok && response.status !== 204) {
    throw await apiError(`grant host maintainer access to '${organization}/${alias}'`, response);
  }
}

export async function revokeRepositoryUsers(
  credentials: GiteaConnection,
  organization: string,
  alias: string
): Promise<void> {
  for (const [role, username] of repositoryUsers(credentials)) {
    const response = await giteaRequest(
      credentials,
      "DELETE",
      `/repos/${organization}/${alias}/collaborators/${username}`
    );
    if (!response.ok && response.status !== 204 && response.status !== 404) {
      throw await apiError(`revoke ${role} access to '${organization}/${alias}'`, response);
    }
  }
}
