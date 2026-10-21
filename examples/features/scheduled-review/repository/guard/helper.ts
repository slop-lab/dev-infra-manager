function isolation(source: string | undefined): unknown {
  const value: unknown = JSON.parse(source ?? '{}');
  if (value === null || typeof value !== 'object' || !('runtime' in value)) return undefined;
  const runtime = value.runtime;
  return runtime !== null && typeof runtime === 'object' && 'isolation' in runtime ? runtime.isolation : undefined;
}

export function securityChanged(before: string | undefined, after: string | undefined): boolean {
  return isolation(before) !== isolation(after);
}
