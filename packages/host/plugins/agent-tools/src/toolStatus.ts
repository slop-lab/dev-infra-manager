/** One guest-side pinned installation check for discovery and operator status. */
export const toolStatusScript = String.raw`
const fs=require("node:fs"),path=require("node:path"),home=fs.realpathSync(process.env.HOME);
const tools=Object.entries({opencode:"1.18.31",codex:"0.156.1"}).map(([name,version])=>{
 let installed=false,fd;try {
  fd=fs.openSync(path.join(home,".local/state/dim-tools",name+".json"),fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
  const info=fs.fstatSync(fd);if(!info.isFile()||info.uid!==process.getuid()||(info.mode&0o777)!==0o600||info.size>16384)throw Error();
  const manifest=JSON.parse(fs.readFileSync(fd,"utf8")),executable=path.join(home,".local/bin",name);
  if(manifest.tool!==name||manifest.version!==version||manifest.executable!==executable)throw Error();
  const target=fs.realpathSync(executable),relative=path.relative(home,target);
  if(relative===".."||relative.startsWith(".."+path.sep)||path.isAbsolute(relative)||!fs.statSync(target).isFile())throw Error();
  fs.accessSync(target,fs.constants.X_OK);installed=true;
 }catch{}finally{if(fd!==undefined)fs.closeSync(fd)}return {name,version,installed};
});if(process.argv.includes("--inspect"))process.exitCode=tools.some(({installed})=>installed)?0:3;else process.stdout.write(JSON.stringify({tools}));`;
