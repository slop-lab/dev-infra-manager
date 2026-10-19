// @ts-check
import source from "../package.json" with { type: "json" };
import { cp, copyFile, writeFile } from "node:fs/promises";
import { minifyPackageJson } from "package.json-minifier";
import { publishPackageVersion } from "../../../scripts/packages/publish-package-version.mjs";

const outputPath = new URL("../dist/package.json", import.meta.url);

if (source.private !== true) throw new Error("The source package.json must remain private");
const output = minifyPackageJson(source, { stripPackagePathPrefix: "./dist", includeFields: ["exports", "types", "publishConfig", "peerDependenciesMeta"] });
output.version = publishPackageVersion(source.version);
output.peerDependencies = { "@slop-lab/dim-control-plane-admin": output.version };
output.peerDependenciesMeta = { "@slop-lab/dim-control-plane-admin": { optional: true } };
output.types = "./index.d.ts";
output.exports = { ".": { types: "./index.d.ts", import: "./index.js", default: "./index.js" } };
output.bin = { "dim-web": "cli.js" };
delete output.private;
await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`);
await copyFile(new URL("../README.md", import.meta.url), new URL("../dist/README.md", import.meta.url));
await copyFile(new URL("../../../LICENSE", import.meta.url), new URL("../dist/LICENSE", import.meta.url));
await cp(new URL("../src/assets", import.meta.url), new URL("../dist/assets", import.meta.url), { recursive: true });
