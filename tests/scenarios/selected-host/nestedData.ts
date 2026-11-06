export const guestNestedData = String.raw`
const fs=require("node:fs"),os=require("node:os"),path=require("node:path"),cp=require("node:child_process");
const [mode,id,challenge]=process.argv.slice(1);
if(!["write","read"].includes(mode)||!id||!/^[a-f0-9-]{36}$/.test(id)||!challenge)throw Error("invalid nested data probe");
const name="dim-smoke-data-"+id,image="dim-smoke-data:"+id;
if(mode==="write"){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),"dim-nested-node-"));
 try{
  const binary=fs.realpathSync(process.execPath),files=new Set([binary]);
  const libraries=cp.execFileSync("ldd",[binary],{encoding:"utf8"});
  for(const match of libraries.matchAll(/\/(?:usr\/)?lib(?:64)?\/[^\s()]+/g))files.add(match[0]);
  for(const file of files){const destination=path.join(root,file);fs.mkdirSync(path.dirname(destination),{recursive:true});fs.copyFileSync(file,destination)}
  const archive=cp.execFileSync("tar",["-C",root,"-cf","-","."],{maxBuffer:256*1024*1024});
  cp.execFileSync("docker",["import","-",image],{input:archive});cp.execFileSync("docker",["volume","create",name]);
 }finally{fs.rmSync(root,{recursive:true,force:true})}
}
const code=mode==="write"?'require("node:fs").writeFileSync("/data/challenge",process.argv[1])':'if(require("node:fs").readFileSync("/data/challenge","utf8")!==process.argv[1])throw Error("nested data changed")';
cp.execFileSync("docker",["run","--rm","--network","none","--mount","type=volume,source="+name+",target=/data","--entrypoint",fs.realpathSync(process.execPath),image,"-e",code,challenge]);
process.stdout.write("nested-data-retained");
`;
