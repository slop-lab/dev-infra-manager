import source from "../package.json" with { type: "json" };
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { publishPackageVersion } from "../../../../../scripts/packages/publish-package-version.ts";
const { private: privateSource, scripts, devDependencies, ...metadata } = source;
if (privateSource !== true) throw new Error("source package must remain private");
const version = publishPackageVersion(source.version);
const entry = (name: string) => ({ types: `./${name}.d.ts`, import: `./${name}.js`, default: `./${name}.js` });
const output = { ...metadata, version, main: "./index.js", types: "./index.d.ts", peerDependencies: { "@slop-lab/dim-host-core": version },
  dependencies: Object.fromEntries(Object.entries(source.dependencies).map(([name, value]) => [name, value.startsWith("workspace:") ? version : value])),
  exports: { ".": entry("index"), "./host": entry("nativeWorkspaceHost"), "./cli": entry("cli/index") } };
await writeFile(new URL("../dist/package.json", import.meta.url), `${JSON.stringify(output, null, 2)}\n`);
await copyFile(new URL("../README.md", import.meta.url), new URL("../dist/README.md", import.meta.url));
await copyFile(new URL("../../../../../LICENSE", import.meta.url), new URL("../dist/LICENSE", import.meta.url));
await mkdir(new URL("../dist/guest", import.meta.url), { recursive: true });
await copyFile(new URL("../src/guest/dim-ci.mjs", import.meta.url), new URL("../dist/guest/dim-ci.mjs", import.meta.url));
