import { UserError } from "../errors.js";

export const workspaceServicePort = 19420;

export function workspaceServiceEndpoint(service: string): string {
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(service)) throw new UserError("invalid workspace service name");
  return `http://127.0.0.1:${workspaceServicePort}/services/${service}`;
}
