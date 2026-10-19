// @ts-check
import source from "../package.json" with { type: "json" };
import { copyFile, writeFile } from "node:fs/promises";
import { publishPackageVersion } from "../../../../../scripts/packages/publish-package-version.mjs";
const { private: privateSource, scripts: sourceScripts, devDependencies, ...metadata } = source;
if (privateSource !== true) throw new Error("The source package.json must remain private");
const output = { ...metadata, version: publishPackageVersion(source.version) };
output.peerDependencies = { "@slop-lab/dim-control-plane": output.version };
output.main = "./index.js";
output.types = "./index.d.ts";
output.exports = { ".": { types: "./index.d.ts", import: "./index.js", default: "./index.js" } };
await writeFile(new URL("../dist/package.json", import.meta.url), `${JSON.stringify(output, null, 2)}\n`);
await copyFile(new URL("../README.md", import.meta.url), new URL("../dist/README.md", import.meta.url));
await copyFile(new URL("../../../../../LICENSE", import.meta.url), new URL("../dist/LICENSE", import.meta.url));
