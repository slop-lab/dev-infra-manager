import { expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { sourceManifest, parseSourceManifest } from '../../../scripts/checks/source-manifest.js';
const helper = new URL('../../../scripts/checks/lib/bootstrap-ubuntu-vm-source.bash', import.meta.url).pathname;
function command(file: string, args: string[], cwd: string) { return spawnSync(file,args,{cwd,encoding:'utf8',timeout:30000,maxBuffer:1024*1024}); }
function git(root: string,...args: string[]) { const r=command('git',args,root);expect(r.status,r.stderr).toBe(0);return r.stdout.trim(); }
async function fixture(merge: boolean) {
 const root=await mkdtemp(join(tmpdir(),'dim-bounded-source-')), repository=join(root,'repository');await mkdir(repository);
 git(repository,'init','--quiet');await writeFile(join(repository,'file'),'root');git(repository,'add','.');git(repository,'-c','user.name=fixture','-c','user.email=fixture@example.invalid','commit','--quiet','-m','root');
 const ancestor=git(repository,'rev-parse','HEAD');await writeFile(join(repository,'file'),'parent');git(repository,'add','.');git(repository,'-c','user.name=fixture','-c','user.email=fixture@example.invalid','commit','--quiet','-m','parent');
 const parent=git(repository,'rev-parse','HEAD'), tree=git(repository,'rev-parse','HEAD^{tree}');const parents=[parent];
 if(merge)parents.push(git(repository,'-c','user.name=fixture','-c','user.email=fixture@example.invalid','commit-tree',tree,'-p',ancestor,'-m','other-parent'));
 const candidate=git(repository,'-c','user.name=fixture','-c','user.email=fixture@example.invalid','commit-tree',tree,...parents.flatMap(p=>['-p',p]),'-m','candidate');git(repository,'update-ref','HEAD',candidate);
 return {root,repository,ancestor,parents,candidate,tree,bundle:join(root,'source.bundle')};
}
function importBundle(root:string,bundle:string,sha:string,tree:string,parents:string[],bare:boolean) {
 git(root,'init','--quiet',...(bare?['--bare']:[]));
 return command('bash',['-euo','pipefail','-c','source "$1"; bootstrap_source_import_bundle "$2" "$3" "$4" "$5" "$6"','bash',helper,root,bundle,sha,tree,parents.join(',')],root);
}
it.each([false,true])('carries exact bounded source through canonical fetch, guest import and clone (merge=%s)',async merge=>{
 const f=await fixture(merge);
 try {
  await writeFile(join(f.repository,'.git/shallow'),f.parents.join('\n')+'\n');git(f.repository,'bundle','create',f.bundle,'HEAD');
  const manifest=await sourceManifest(f.repository);expect(manifest.boundedParents).toEqual(f.parents);
  const old=join(f.root,'old');await mkdir(old);git(old,'init','--bare','--quiet');
  const red=command('git',['fetch','--quiet','--no-tags',f.bundle,f.candidate],old);expect(red.status).not.toBe(0);expect(red.stderr).toContain('did not send all necessary objects');
  for(const bare of [true,false]){
   const target=join(f.root,bare?'bare':'guest');await mkdir(target);const result=importBundle(target,f.bundle,f.candidate,f.tree,f.parents,bare);expect(result.status,result.stderr).toBe(0);
   expect(git(target,'rev-parse','HEAD','HEAD^{tree}','HEAD^').split('\n')).toEqual([f.candidate,f.tree,f.parents[0]]);
   git(target,'fsck','--strict','--full');expect(command('git',['cat-file','-e',f.ancestor],target).status).not.toBe(0);
   if(!bare){git(target,'checkout','--quiet','--detach',f.candidate);expect(git(target,'status','--porcelain=v1')).toBe('');}
  }
  const cloned=join(f.root,'clone');git(f.root,'clone','--quiet','--no-local',join(f.root,'bare'),cloned);git(cloned,'fsck','--strict','--full');expect(git(cloned,'rev-parse','HEAD^')).toBe(f.parents[0]);expect(git(cloned,'status','--porcelain=v1')).toBe('');
 }finally{await rm(f.root,{recursive:true,force:true});}
});
it('keeps full-history input explicit and rejects misleading or unrelated bounded ancestry',async()=>{
 const f=await fixture(false);
 try{
  expect((await sourceManifest(f.repository)).boundedParents).toBeUndefined();git(f.repository,'bundle','create',f.bundle,'HEAD');
  const full=join(f.root,'full');await mkdir(full);expect(importBundle(full,f.bundle,f.candidate,f.tree,[],true).status).toBe(0);expect(git(full,'rev-parse','HEAD^^')).toBe(f.ancestor);
  const extra=join(f.root,'extra');await mkdir(extra);const rejected=importBundle(extra,f.bundle,f.candidate,f.tree,f.parents,true);expect(rejected.status).not.toBe(0);expect(rejected.stderr).toContain('outside its immediate context');
  const wrong=join(f.root,'wrong');await mkdir(wrong);const mismatch=importBundle(wrong,f.bundle,f.candidate,f.tree,[f.ancestor],true);expect(mismatch.status).not.toBe(0);expect(mismatch.stderr).toContain('do not match raw candidate');
  await writeFile(join(f.repository,'.git/shallow'),f.ancestor+'\n');await expect(sourceManifest(f.repository)).rejects.toThrow('exactly every immediate parent');
 }finally{await rm(f.root,{recursive:true,force:true});}
});
it('rejects malformed, empty, duplicated, oversized or additional source manifest fields',()=>{
 const base={schemaVersion:1,sourceSha:'a'.repeat(40),sourceTree:'b'.repeat(40)};
 for(const boundedParents of [[],['a'.repeat(40),'a'.repeat(40)],['short'],Array.from({length:9},(_,i)=>i.toString(16).padStart(40,'0'))])expect(()=>parseSourceManifest({...base,boundedParents})).toThrow();
 expect(()=>parseSourceManifest({...base,extra:true})).toThrow();expect(parseSourceManifest(base)).toEqual(base);
});
it('reads the strict bounded manifest using the actual standalone bootstrap parser',async()=>{
 const root=await mkdtemp(join(tmpdir(),'dim-source-manifest-'));
 try{const file=join(root,'manifest.json'),bundle=join(root,'input.bundle');await writeFile(bundle,'input');await writeFile(file,JSON.stringify({schemaVersion:1,sourceSha:'a'.repeat(40),sourceTree:'b'.repeat(40),boundedParents:['c'.repeat(40)]}));
  const result=command('bash',['-euo','pipefail','-c','source "$1"; bootstrap_source_parse --source-bundle "$2" --source-manifest "$3"; printf "%s" "$SOURCE_BOUNDED_PARENTS"','bash',helper,bundle,file],resolve(root));expect(result.status,result.stderr).toBe(0);expect(result.stdout).toBe('c'.repeat(40));
 }finally{await rm(root,{recursive:true,force:true});}
});
