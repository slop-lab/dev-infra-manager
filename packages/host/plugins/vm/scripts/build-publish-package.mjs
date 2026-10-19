// @ts-check
import source from "../package.json" with { type: "json" };
import { copyFile, writeFile } from "node:fs/promises";
import { publishPackageVersion } from "../../../../../scripts/packages/publish-package-version.mjs";
const { private: privateSource, scripts: sourceScripts, devDependencies, ...metadata } = source;
if (privateSource !== true) throw new Error("The source package.json must remain private");
const version = publishPackageVersion(source.version);
const output = { ...metadata, version, peerDependencies: { "@slop-lab/dim-core": version },
  main: "./index.js", types: "./index.d.ts", exports: { ".": { types: "./index.d.ts", import: "./index.js", default: "./index.js" }, "./budget-setup": "./install-budget-helper.bash" } };
await writeFile(new URL("../dist/package.json", import.meta.url), `${JSON.stringify(output, null, 2)}\n`);
await copyFile(new URL("../README.md", import.meta.url), new URL("../dist/README.md", import.meta.url));
await copyFile(new URL("../../../../../LICENSE", import.meta.url), new URL("../dist/LICENSE", import.meta.url));

await copyFile(new URL("./install-budget-helper.bash", import.meta.url), new URL("../dist/install-budget-helper.bash", import.meta.url));

await copyFile(new URL("./artifact-cache.bash", import.meta.url), new URL("../dist/artifact-cache.bash", import.meta.url));
