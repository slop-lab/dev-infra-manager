import source from "../package.json" with {type:"json"};
import {writeFile} from "node:fs/promises";
import {publishPackageVersion} from "../../../../scripts/packages/publish-package-version.ts";
const {private:privateSource,scripts,devDependencies,...metadata}=source;
if(privateSource!==true)throw new Error("source package must remain private");
const version=publishPackageVersion(source.version);
const exports=Object.fromEntries(Object.entries(source.exports).map(([key,entry])=>[key,{types:entry.types.replace("./dist/","./"),import:entry.import.replace("./dist/","./"),default:entry.default.replace("./dist/","./")} ]));
const dependencies=Object.fromEntries(Object.entries(source.dependencies).map(([key,value])=>[key,value.startsWith("workspace:")?version:value]));
await writeFile(new URL("../dist/package.json",import.meta.url),JSON.stringify({...metadata,version,main:"./index.js",types:"./index.d.ts",exports,dependencies},null,2)+"\n");
