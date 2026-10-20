import source from "../package.json" with { type: "json" };
import { copyFile, writeFile } from "node:fs/promises";
import { publishPackageVersion } from "../../../../../scripts/packages/publish-package-version.ts";
const { private: privateSource, scripts, devDependencies, ...metadata } = source;
if (privateSource !== true) throw new Error("source package must remain private");
const version = publishPackageVersion(source.version);
const entry = (name: string) => ({ types: `./${name}.d.ts`, import: `./${name}.js`, default: `./${name}.js` });
const output = { ...metadata, version, main: "./index.js", types: "./index.d.ts", peerDependencies: { "@slop-lab/dim-host-core": version },
  dependencies: { ...source.dependencies, "@slop-lab/dim-contracts-git": version },
  exports: { ".": entry("index"), "./host": entry("nativeWorkspaceHost"), "./cli": entry("cli/index") } };
await writeFile(new URL("../dist/package.json", import.meta.url), `${JSON.stringify(output, null, 2)}\n`);
await copyFile(new URL("../README.md", import.meta.url), new URL("../dist/README.md", import.meta.url));
await copyFile(new URL("../../../../../LICENSE", import.meta.url), new URL("../dist/LICENSE", import.meta.url));
