import { readTarget, type ReviewChange } from 'dim:review';
import { securityChanged } from './helper.ts';

export async function matches(changes: readonly ReviewChange[]): Promise<boolean> {
  return changes.length > 0 && securityChanged(
    await readTarget('app.json', 'before'),
    await readTarget('app.json', 'after')
  );
}
