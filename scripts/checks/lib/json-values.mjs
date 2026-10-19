// @ts-check
/** @param {unknown} value @returns {Record<string, unknown>} */
export function object(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("expected a JSON object");
  return /** @type {Record<string, unknown>} */ (value);
}
/** @param {unknown} value @returns {unknown[]} */
export function array(value) {
  if (!Array.isArray(value)) throw new Error("expected a JSON array");
  return value;
}
/** @param {unknown} value @returns {string} */
export function string(value) {
  if (typeof value !== "string") throw new Error("expected a JSON string");
  return value;
}
/** @param {string} text @returns {unknown} */
export function parseJson(text) { return JSON.parse(text); }
