import { UserError } from "../errors.js";

export type GiteaOrganizationIdentity = {
  readonly id: number;
  readonly username: string;
};

export async function parseGiteaOrganizationIdentity(
  response: Response,
  expectedUsername: string
): Promise<GiteaOrganizationIdentity> {
  const value: unknown = await response.json();
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw invalidIdentity();
  const id = Reflect.get(value, "id");
  const username = Reflect.get(value, "username");
  if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0 || username !== expectedUsername) {
    throw invalidIdentity();
  }
  return { id, username };
}

export function assertGiteaOrganizationIdentity(
  identity: GiteaOrganizationIdentity,
  expectedId: number
): void {
  if (identity.id !== expectedId) throw invalidIdentity();
}

function invalidIdentity(): UserError {
  return new UserError("Gitea organization identity does not match trusted Project state");
}
