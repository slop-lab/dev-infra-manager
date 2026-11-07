import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { lstat, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
export type SourceManifest = { schemaVersion: 1; sourceSha: string; sourceTree: string; boundedParents?: string[] };
const oid = /^[a-f0-9]{40}$/;
export function parseSourceManifest(value: unknown): SourceManifest {
  assert(value && typeof value === 'object' && !Array.isArray(value), 'source manifest must be an object');
  const record = value as Record<string, unknown>, keys = Object.keys(record).sort();
  const expected = ['schemaVersion', 'sourceSha', 'sourceTree', ...(record.boundedParents === undefined ? [] : ['boundedParents'])].sort();
  assert.deepEqual(keys, expected, 'manifest must contain only schemaVersion, sourceSha, sourceTree and optional boundedParents');
  assert(record.schemaVersion === 1 && typeof record.sourceSha === 'string' && oid.test(record.sourceSha)
    && typeof record.sourceTree === 'string' && oid.test(record.sourceTree), 'manifest requires exact source SHA and tree');
  if (record.boundedParents !== undefined) {
    assert(Array.isArray(record.boundedParents) && record.boundedParents.length > 0 && record.boundedParents.length <= 8
      && record.boundedParents.every(parent => typeof parent === 'string' && oid.test(parent))
      && new Set(record.boundedParents).size === record.boundedParents.length, 'boundedParents must contain one to eight distinct exact immediate parents');
  }
  return record as SourceManifest;
}
export async function sourceManifest(repository: string): Promise<SourceManifest> {
  const git = (...args: string[]) => {
    const result = spawnSync('git', ['-C', repository, ...args], { encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024 });
    assert.equal(result.status, 0, `cannot inspect exact source: git ${args[0]}`); return result.stdout.trim();
  };
  const value: SourceManifest = { schemaVersion: 1, sourceSha: git('rev-parse', 'HEAD'), sourceTree: git('rev-parse', 'HEAD^{tree}') };
  const shallow = resolve(repository, git('rev-parse', '--git-path', 'shallow'));
  let exists = false;
  try { const info = await lstat(shallow); assert(info.isFile() && !info.isSymbolicLink() && info.size <= 1024, 'unsafe source shallow metadata'); exists = true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  if (exists) {
    const parents = git('cat-file', 'commit', value.sourceSha).split('\n\n', 1)[0]!.split('\n').filter(line => line.startsWith('parent ')).map(line => line.slice(7));
    const boundaries = (await readFile(shallow, 'utf8')).trim().split('\n');
    assert.deepEqual([...boundaries].sort(), [...parents].sort(), 'bounded source must mark exactly every immediate parent shallow');
    value.boundedParents = parents;
  }
  return parseSourceManifest(value);
}
if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const [operation, input, output] = process.argv.slice(2);
  assert(input && ['create', 'read'].includes(operation ?? ''), 'usage: source-manifest.ts create REPOSITORY OUTPUT | read MANIFEST');
  if (operation === 'create') {
    assert(output, 'new source manifest output required');
    await writeFile(output, JSON.stringify(await sourceManifest(input)) + '\n', { mode: 0o600, flag: 'wx' });
  } else {
    const value = parseSourceManifest(JSON.parse(await readFile(input, 'utf8')));
    console.log(`${value.sourceSha} ${value.sourceTree} ${value.boundedParents?.join(',') ?? ''}`);
  }
}
