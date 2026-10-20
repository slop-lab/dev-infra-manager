import source from "../package.json" with { type: "json" };
import { copyFile, writeFile } from "node:fs/promises";
import { publishPackageVersion } from "../../../../../scripts/packages/publish-package-version.ts";

if (source.private !== true) throw new Error("The host mirror provider source package must remain private");
const { private: privateSource, scripts, devDependencies, ...metadata } = source;
const version = publishPackageVersion(source.version);
const output = { ...metadata, version, types: "./index.d.ts", main: "./index.js",
  peerDependencies: { "@slop-lab/dim-host-core": version },
  exports: { ".": { types: "./index.d.ts", import: "./index.js", default: "./index.js" }, "./adapter": { types: "./adapter.d.ts", import: "./adapter.js", default: "./adapter.js" } } };
await writeFile(new URL("../dist/package.json", import.meta.url), `${JSON.stringify(output, null, 2)}\n`);
await copyFile(new URL("../README.md", import.meta.url), new URL("../dist/README.md", import.meta.url));
await copyFile(new URL("../../../../../LICENSE", import.meta.url), new URL("../dist/LICENSE", import.meta.url));
