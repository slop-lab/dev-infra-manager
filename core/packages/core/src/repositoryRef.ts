import { UserError } from "./errors.js";

export function normalizeRepositoryRef(value: string): string {
  if (/^[0-9a-f]{40,64}$/.test(value)) return value;
  const ref = value.startsWith("refs/") ? value : `refs/heads/${value}`;
  if (!/^refs\/(?:heads|tags|pull)\/[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(ref) || ref.includes("..") || ref.endsWith("/")) {
    throw new UserError(`repository ref '${value}' is invalid`);
  }
  return ref;
}
