// @ts-check
import { readText, readTarget } from 'dim:review';
import { watchedIsolation } from './helper.mjs';

export async function matches() {
  const [before, after] = await Promise.all([
    readTarget('app/config.json', 'before'),
    readTarget('app/config.json', 'after'),
  ]);
  if (JSON.parse(after ?? '{}').runtime?.inspectExtra) await readText('.dim/review/extra.json');
  return watchedIsolation(before) !== watchedIsolation(after);
}
