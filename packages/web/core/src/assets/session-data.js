// @ts-check
/** @param {unknown} value @returns {Record<string, unknown> | null} */
export function record(value) { return value !== null && typeof value === "object" && !Array.isArray(value) ? /** @type {Record<string,unknown>} */ (value) : null; }
/** @param {unknown} value */
export function text(value) { return typeof value === "string" ? value : null; }
/** @param {unknown} value */
export function parseSession(value) {
  const input = record(value), capabilities = record(input?.capabilities), csrfToken = text(input?.csrfToken);
  const username = text(input?.username), administration = record(input?.accountAdministration);
  if (input?.authenticated !== true || csrfToken === null || !username || typeof capabilities?.operations !== "boolean"
    || !Array.isArray(input.roles) || !input.roles.every((role) => typeof role === "string" && ["read", "operator", "reviewer"].includes(role))) return null;
  if (input.accountAdministration !== undefined && (!administration || !Array.isArray(administration.command) || !administration.command.length
    || !administration.command.every((arg) => typeof arg === "string" && arg.length > 0) || typeof administration.configPath !== "string")) return null;
  return { username, csrfToken, roles: /** @type {string[]} */ (input.roles), capabilities: { operations: capabilities.operations },
    accountAdministration: administration ? { command: /** @type {string[]} */ (administration.command), configPath: /** @type {string} */ (administration.configPath) } : null };
}
