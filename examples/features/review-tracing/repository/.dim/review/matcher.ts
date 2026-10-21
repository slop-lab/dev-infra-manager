import { readText, readTarget, type ReviewChange } from 'dim:review';
import { inspectsExtra, watchedIsolation } from './helper.ts';

export async function matches(_changes: readonly ReviewChange[]): Promise<boolean> {
  const [before, after] = await Promise.all([
    readTarget('app/config.json', 'before'),
    readTarget('app/config.json', 'after'),
  ]);
  if (inspectsExtra(after)) await readText('.dim/review/extra.json');
  return watchedIsolation(before) !== watchedIsolation(after);
}
