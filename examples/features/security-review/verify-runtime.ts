import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runDockerProjectMatcher } from "./project-matcher.ts";
const source = await readFile(new URL("./repository/.dim/review/matcher.mjs", import.meta.url), "utf8");
assert.equal(await runDockerProjectMatcher({ source, changes: [{ newPath: "app/config.json", before: '{"theme":"light"}', after: '{"theme":"dark"}' }] }), false);
assert.equal(await runDockerProjectMatcher({ source, changes: [{ newPath: "app/config.json", before: '{"allowHostAccess":false}', after: '{"allowHostAccess":true}' }] }), true);
assert.equal(await runDockerProjectMatcher({ source: String.raw`
import {existsSync, readFileSync, writeFileSync} from 'node:fs';
import {networkInterfaces} from 'node:os';
export function matches(){
  if(process.getuid()!==65534 || existsSync('/var/run/docker.sock')) throw Error('identity/socket boundary');
  if(Object.values(networkInterfaces()).flat().some(value=>value&&!value.internal)) throw Error('network boundary');
  const status=readFileSync('/proc/self/status','utf8');
  if(!/CapEff:\s+0+\n/.test(status)||!/NoNewPrivs:\s+1\n/.test(status)) throw Error('privilege boundary');
  try{writeFileSync('/dim-boundary-probe','x');throw Error('writeable root');}catch(error){if(error.code!=='EROFS'&&error.code!=='EACCES')throw error;}
  return true;
}`, changes: [] }), true);
await assert.rejects(runDockerProjectMatcher({ source: "export function matches(){throw Error('broken')}", changes: [] }));
await assert.rejects(runDockerProjectMatcher({ source: "export function matches(){return 'false'}", changes: [] }));
await assert.rejects(runDockerProjectMatcher({ source: "export function matches(){process.stdout.write('x'.repeat(5000)); return false;}", changes: [] }));
await assert.rejects(runDockerProjectMatcher({ source: "export function matches(){for(;;){}}", changes: [] }));
console.log("PASS project-owned matcher: isolated true/false, runtime boundaries, error, malformed result, output limit, timeout");
