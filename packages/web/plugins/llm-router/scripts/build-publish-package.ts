import { cp, copyFile, readFile, writeFile } from "node:fs/promises";
import { publishPackageVersion } from "../../../../../scripts/packages/publish-package-version.ts";
const source = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const version = publishPackageVersion(source.version);
const dependencies = Object.fromEntries(Object.entries(source.dependencies as Record<string,string>).map(([name, value]) => [name, value.startsWith("workspace:") ? version : value]));
await writeFile(new URL("../dist/package.json", import.meta.url), JSON.stringify({ name: source.name, version, type: "module", license: "MIT", main: "./index.js", types: "./index.d.ts", exports: { ".": { types: "./index.d.ts", import: "./index.js", default: "./index.js" } }, dependencies, peerDependencies: { "@slop-lab/dim-web": version }, engines: source.engines }, null, 2) + "\n");
await cp(new URL("../src/assets", import.meta.url), new URL("../dist/assets", import.meta.url), { recursive: true });
await copyFile(new URL("../README.md", import.meta.url), new URL("../dist/README.md", import.meta.url));
await copyFile(new URL("../../../../../LICENSE", import.meta.url), new URL("../dist/LICENSE", import.meta.url));
