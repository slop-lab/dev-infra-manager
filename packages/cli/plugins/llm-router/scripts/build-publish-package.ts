import { chmod, copyFile, readFile, writeFile } from "node:fs/promises";
import { publishPackageVersion } from "../../../../../scripts/packages/publish-package-version.ts";
const source = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as { name: string; version: string; description: string; dependencies: Record<string, string>; engines: Record<string, string> };
const dependencies = Object.fromEntries(Object.entries(source.dependencies).map(([name, version]) => [name, version.startsWith("workspace:") ? publishPackageVersion(source.version) : version]));
await writeFile(new URL("../dist/package.json", import.meta.url), JSON.stringify({ name: source.name, version: publishPackageVersion(source.version), description: source.description, license: "MIT", type: "module", main: "./index.js", types: "./index.d.ts", exports: { ".": { types: "./index.d.ts", import: "./index.js", default: "./index.js" } }, dependencies, peerDependencies: { "@slop-lab/dim-host-core": publishPackageVersion(source.version) }, peerDependenciesMeta: { "@slop-lab/dim-host-core": { optional: true } }, bin: { "dim-llm-router": "./main.js" }, engines: source.engines }, null, 2) + "\n");
await copyFile(new URL("../README.md", import.meta.url), new URL("../dist/README.md", import.meta.url));
await copyFile(new URL("../../../../../LICENSE", import.meta.url), new URL("../dist/LICENSE", import.meta.url));

await chmod(new URL("../dist/main.js", import.meta.url), 0o755);
