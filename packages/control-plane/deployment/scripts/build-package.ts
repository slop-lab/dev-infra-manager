import source from "../package.json" with { type: "json" };
import { writeFile } from "node:fs/promises";
const { scripts, devDependencies, ...metadata } = source;
await writeFile(new URL("../dist/package.json", import.meta.url), JSON.stringify({...metadata, exports: {".": "./index.js", "./deployment-cli": "./deployment-cli.js"}, main: "./index.js", types: "./index.d.ts"}, null, 2)+"\n");
