// @ts-check
import { readText } from 'dim:review';
const source = await readText('.dim/review/settings.json');
if (source === undefined) throw Error('review settings are missing');
const settings = JSON.parse(source);

/** @param {string | undefined} source */
export function watchedIsolation(source) {
  const value = JSON.parse(source ?? '{}');
  return settings.watchIsolation ? value.runtime?.isolation : undefined;
}
