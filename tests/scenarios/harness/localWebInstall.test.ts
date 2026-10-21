import { mkdirSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readlink, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { installLocalWeb, webArtifacts } from "../../../scripts/install-local-web.ts";

const roots: string[] = [];
const version = "0.10.0-local-test";
const manifest = { schemaVersion: 1, packages: [
  { name: "@slop-lab/dim-cli", version, file: "cli.tgz" },
  { name: "@slop-lab/dim-web", version, file: "web.tgz", requires: {} },
  { name: "@slop-lab/dim-control-plane-admin", version, file: "admin.tgz", requires: { "@slop-lab/dim-host-core": version } },
  { name: "@slop-lab/dim-host-core", version, file: "core.tgz" },
] };
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
it("includes exact operator-client dependencies and rejects mismatches or escaped artifacts", () => {
  expect(webArtifacts(manifest).map(({ file }) => file)).toEqual(["admin.tgz", "core.tgz", "web.tgz"]);
  expect(() => webArtifacts({ ...manifest, packages: manifest.packages.map((entry) => entry.file === "core.tgz" ? { ...entry, version: "0.9.0" } : entry) })).toThrow(/matching/);
  expect(() => webArtifacts({ ...manifest, packages: [...manifest.packages, manifest.packages[0]] })).toThrow(/duplicate/);
  expect(() => webArtifacts({ ...manifest, packages: manifest.packages.map((entry) => ({ ...entry, file: "../outside.tgz" })) })).toThrow(/unsafe/);
});
it("selects the isolated runtime idempotently and preserves it when installation fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "dim-web-install-")); roots.push(root);
  const bundle = join(root, "bundle"), data = join(root, "data"); await mkdir(bundle);
  await writeFile(join(bundle, "packages.json"), JSON.stringify(manifest));
  for (const { file } of manifest.packages) await writeFile(join(bundle, file), file);
  await mkdir(join(data, "runtime/current"), { recursive: true });
  const coreMarker = join(data, "runtime/current/package.json");
  await writeFile(coreMarker, "existing host core");
  let calls = 0;
  const install = (args: readonly string[]) => {
    calls += 1;
    expect(args).toContain("--ignore-scripts");
    const stage = args[args.indexOf("--prefix") + 1]!;
    // The production installer is synchronous; use its same filesystem visibility.
    mkdirSync(join(stage, "node_modules/.bin"), { recursive: true });
    writeFileSync(join(stage, "node_modules/.bin/dim-web"), "web");
  };
  const executable = await installLocalWeb(bundle, data, install);
  expect(executable).toBe(join(data, "web/runtime/current/node_modules/.bin/dim-web"));
  expect(await readFile(executable, "utf8")).toBe("web");
  await installLocalWeb(bundle, data, install); expect(calls).toBe(1);
  const before = await readlink(join(data, "web/runtime/current"));
  await writeFile(join(bundle, "web.tgz"), "updated web");
  await expect(installLocalWeb(bundle, data, () => { throw new Error("npm failed"); })).rejects.toThrow("npm failed");
  expect(await readlink(join(data, "web/runtime/current"))).toBe(before);
  expect(await readFile(executable, "utf8")).toBe("web");
  expect(await readFile(coreMarker, "utf8")).toBe("existing host core");
});
