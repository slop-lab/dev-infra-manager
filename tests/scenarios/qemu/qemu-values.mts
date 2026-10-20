export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function errorCode(error: unknown) {
  return error !== null && typeof error === 'object' && 'code' in error ? error.code : undefined;
}
