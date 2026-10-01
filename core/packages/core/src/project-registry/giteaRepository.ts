import { giteaRequest } from "../gitea.js";
import type { GiteaConnection } from "../gitea.js";
import { UserError } from "../errors.js";
import { apiError } from "./helpers.js";
import { assertGiteaOrganizationIdentity, parseGiteaOrganizationIdentity } from "./giteaOrganization.js";

export async function ensureOrganization(
  credentials: GiteaConnection,
  organization: string,
  trustedId: number | null
): Promise<number> {
  if (trustedId !== null) {
    const existing = await giteaRequest(credentials, "GET", `/orgs/${organization}`);
    if (!existing.ok) throw await apiError(`verify Gitea organization '${organization}'`, existing);
    const identity = await parseGiteaOrganizationIdentity(existing, organization);
    assertGiteaOrganizationIdentity(identity, trustedId);
    return identity.id;
  }
  const response = await giteaRequest(credentials, "POST", "/orgs", {
    username: organization,
    full_name: organization,
    visibility: "public"
  });
  if (response.status === 422) {
    throw new UserError(
      `Gitea organization '${organization}' exists without a trusted ID; administrator reconciliation is required`
    );
  }
  if (!response.ok) throw await apiError(`create Gitea organization '${organization}'`, response);
  const identity = await parseGiteaOrganizationIdentity(response, organization);
  return identity.id;
}

export async function createGiteaRepository(
  credentials: GiteaConnection,
  organization: string,
  alias: string,
  root: boolean
): Promise<void> {
  const response = await giteaRequest(
    credentials,
    "POST",
    `/orgs/${organization}/repos`,
    giteaRepositoryCreationOptions(alias, root)
  );
  if (response.ok) return;
  if (response.status === 409 || response.status === 422) {
    const existing = await giteaRequest(credentials, "GET", `/repos/${organization}/${alias}`);
    if (existing.ok) return;
  }
  throw await apiError(`create repo '${organization}/${alias}'`, response);
}

export function giteaRepositoryCreationOptions(alias: string, root: boolean): Record<string, unknown> {
  return {
    name: alias,
    private: false,
    auto_init: false,
    has_issues: root
  };
}
