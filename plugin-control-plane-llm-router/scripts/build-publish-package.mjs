// @ts-check
import { chmod, cp, copyFile, readFile, writeFile } from "node:fs/promises";
import { publishPackageVersion } from "../../core/scripts/publish-package-version.mjs";
/** @type {unknown} */
const value = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
if (typeof value !== "object" || value === null || !("version" in value) || typeof value.version !== "string"
  || !("name" in value) || typeof value.name !== "string") throw new Error("invalid plugin metadata");
const version = publishPackageVersion(value.version);
await writeFile(new URL("../dist/package.json", import.meta.url), JSON.stringify({
  name: value.name, version, type: "module", license: "MIT", main: "./index.js", types: "./index.d.ts",
  exports: { ".": { types: "./index.d.ts", import: "./index.js", default: "./index.js" },  },
  dependencies: { "@slop-lab/dim-control-plane": version }, bin: { "dim-control-plane-llm-router": "./main.js" }, engines: { node: "^24.0.0 || ^26.0.0" }
}, null, 2) + "\n");
await copyFile(new URL("../README.md", import.meta.url), new URL("../dist/README.md", import.meta.url));
await copyFile(new URL("../../LICENSE", import.meta.url), new URL("../dist/LICENSE", import.meta.url));

await cp(new URL("../docs", import.meta.url), new URL("../dist/docs", import.meta.url), { recursive: true });

await chmod(new URL("../dist/main.js", import.meta.url), 0o755);
