import { UserError } from "../errors.js";

/** Reserved suffix for workspace-internal names resolved by the per-workspace name service. */
export const DIM_INTERNAL_SUFFIX = ".dim.internal";
const LABEL = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

/** A plugin-owned name; the registry maps it to an upstream the ingress forwards to. */
export interface WorkspaceNameRegistration { readonly name: string; readonly upstream: string }

export function validateWorkspaceInternalName(name: string): string {
  if (typeof name !== "string" || name.length === 0 || name.length > 253 || !name.endsWith(DIM_INTERNAL_SUFFIX)) {
    throw new UserError(`invalid workspace internal name '${name}'; expected a hostname under '${DIM_INTERNAL_SUFFIX}'`);
  }
  if (name.split(".").some((label) => !LABEL.test(label))) {
    throw new UserError(`invalid workspace internal name '${name}'; labels must be lowercase alphanumerics or hyphens`);
  }
  return name;
}

/** Normalizes to a bare 'http://host:port/' origin: no credentials, path, query or hash. */
export function validateWorkspaceUpstream(upstream: string): string {
  let parsed: URL;
  try { parsed = new URL(upstream); } catch { throw new UserError(`invalid workspace name upstream '${upstream}'; expected an absolute http origin`); }
  if (parsed.protocol !== "http:" || parsed.username !== "" || parsed.password !== "" || parsed.search !== "" || parsed.hash !== ""
    || parsed.pathname !== "/" || parsed.port === "" || parsed.hostname === "") {
    throw new UserError(`invalid workspace name upstream '${upstream}'; expected 'http://HOST:PORT/' with no path, credentials or query`);
  }
  return `http://${parsed.host}/`;
}

export function validateNameRegistration(registration: WorkspaceNameRegistration): WorkspaceNameRegistration {
  if (typeof registration !== "object" || registration === null) throw new UserError("invalid workspace name registration");
  return { name: validateWorkspaceInternalName(registration.name), upstream: validateWorkspaceUpstream(registration.upstream) };
}
