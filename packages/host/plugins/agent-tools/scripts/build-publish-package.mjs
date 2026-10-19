// @ts-check
import source from "../package.json" with { type: "json" };
import { copyFile, writeFile, cp } from "node:fs/promises";
import { publishPackageVersion } from "../../../../../scripts/packages/publish-package-version.mjs";
const { private: privateSource, scripts, devDependencies, ...metadata } = source;
if (privateSource !== true) throw new Error("The source package.json must remain private");
const version = publishPackageVersion(source.version);
const output = { ...metadata, version, main: "./index.js", types: "./index.d.ts",
  peerDependencies: { "@slop-lab/dim-host-core": version },
  exports: { ".": { types: "./index.d.ts", import: "./index.js", default: "./index.js" } } };
await writeFile(new URL("../dist/package.json", import.meta.url), `${JSON.stringify(output, null, 2)}\n`);
await copyFile(new URL("../README.md", import.meta.url), new URL("../dist/README.md", import.meta.url));
await cp(new URL("../src/assets", import.meta.url), new URL("../dist/assets", import.meta.url), { recursive: true });
await copyFile(new URL("../../../../../LICENSE", import.meta.url), new URL("../dist/LICENSE", import.meta.url));
