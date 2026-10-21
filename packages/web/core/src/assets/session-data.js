// @ts-check
/** @param {unknown} value @returns {Record<string, unknown> | null} */
export function record(value) { return value !== null && typeof value === "object" && !Array.isArray(value) ? /** @type {Record<string,unknown>} */ (value) : null; }
/** @param {unknown} value */
export function text(value) { return typeof value === "string" ? value : null; }
/** @param {unknown} value */
export function parseSession(value) {
  const input = record(value), capabilities = record(input?.capabilities), csrfToken = text(input?.csrfToken);
  if (input?.authenticated !== true || csrfToken === null || typeof capabilities?.operations !== "boolean"
    || !Array.isArray(input.roles) || !input.roles.every((role) => typeof role === "string" && ["read", "operator", "reviewer"].includes(role))) return null;
  return { csrfToken, roles: /** @type {string[]} */ (input.roles), capabilities: { operations: capabilities.operations } };
}
