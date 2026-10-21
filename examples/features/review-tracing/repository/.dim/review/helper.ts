import { readText } from 'dim:review';
const source = await readText('.dim/review/settings.json');
if (source === undefined) throw Error('review settings are missing');
const settings = object(JSON.parse(source) as unknown);

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function watchedIsolation(source: string | undefined): unknown {
  const value = object(JSON.parse(source ?? '{}') as unknown);
  return settings.watchIsolation === true ? object(value.runtime).isolation : undefined;
}

export function inspectsExtra(source: string | undefined): boolean {
  const value = object(JSON.parse(source ?? '{}') as unknown);
  return object(value.runtime).inspectExtra === true;
}
