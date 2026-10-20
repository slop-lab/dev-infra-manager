import { chmod, cp, copyFile, readFile, writeFile } from "node:fs/promises";
import { publishPackageVersion } from "../../../../../scripts/packages/publish-package-version.ts";
const metadata: unknown = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
if (!metadata || typeof metadata !== "object" || !("name" in metadata) || typeof metadata.name !== "string"
  || !("version" in metadata) || typeof metadata.version !== "string") throw new Error("invalid CI plugin metadata");
const version = publishPackageVersion(metadata.version);
await writeFile(new URL("../dist/package.json", import.meta.url), JSON.stringify({
  name: metadata.name, version, type: "module", license: "MIT", main: "./index.js", types: "./index.d.ts",
  exports: { ".": { types: "./index.d.ts", import: "./index.js", default: "./index.js" } },
  dependencies: { "@slop-lab/dim-contracts-ci": version, zod: "4.1.11" },
  peerDependencies: { "@slop-lab/dim-control-plane-core": version }, engines: { node: "^24.0.0 || ^26.0.0" }, bin: { "dim-ci-service": "./cli.js" }
}, null, 2) + "\n");
await copyFile(new URL("../../../../../LICENSE", import.meta.url), new URL("../dist/LICENSE", import.meta.url));
await chmod(new URL("../dist/cli.js", import.meta.url), 0o755);
await copyFile(new URL("../README.md", import.meta.url), new URL("../dist/README.md", import.meta.url));
