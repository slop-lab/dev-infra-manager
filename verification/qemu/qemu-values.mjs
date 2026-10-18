// @ts-check
/** @param {unknown} value @returns {value is Record<string, unknown>} */
export function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
/** @param {unknown} error */
export function errorCode(error) {
  return error !== null && typeof error === 'object' && 'code' in error ? error.code : undefined;
}
