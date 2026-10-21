import source from "../package.json" with { type: "json" };
import { copyFile, writeFile } from "node:fs/promises";
import { publishPackageVersion } from "../../../../scripts/packages/publish-package-version.ts";
const { private: privateSource, scripts: sourceScripts, devDependencies, ...metadata } = source;
if (privateSource !== true) throw new Error("source package must remain private");
const entry = (name: string) => ({ types: `./${name}.d.ts`, import: `./${name}.js`, default: `./${name}.js` });
const output = { ...metadata, version: publishPackageVersion(source.version), main: "./index.js", types: "./index.d.ts",
  exports: { ".": entry("index"), "./plugin-api": entry("plugin-api"), "./lock": entry("lock") }, bin: { "dim-control-plane": "./cli.js" } };
await writeFile(new URL("../dist/package.json", import.meta.url), `${JSON.stringify(output, null, 2)}\n`);
await copyFile(new URL("../README.md", import.meta.url), new URL("../dist/README.md", import.meta.url));
await copyFile(new URL("../../../../LICENSE", import.meta.url), new URL("../dist/LICENSE", import.meta.url));
