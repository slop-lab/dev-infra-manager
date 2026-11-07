import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import { examplePluginSpecifiers } from "../../../scripts/examples/bundle.ts";

const run = promisify(execFile), roots: string[] = [];
const scripts = resolve(import.meta.dirname, "../../../scripts/examples");
type Manifest = { schemaVersion: number; packages: { name: string; version: string; file: string; requires: Record<string, string> }[] };
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

async function fixture(version: string, archiveVersion = version) {
  const root = await mkdtemp(join(tmpdir(), "dim-installed-example-bundle-")); roots.push(root);
  const bundle = join(root, "bundle"), bin = join(root, "bin"), stage = join(root, "stage"), marker = join(root, "npm-args"), runtime = join(root, "runtime");
  await mkdir(bundle); await mkdir(bin); await mkdir(join(stage, "package"), { recursive: true });
  await mkdir(runtime, { mode: 0o700 });
  const manifest: Manifest = { schemaVersion: 1, packages: ["dim-cli", "dim-installer", "dim-host-core"].map((name) => ({
    name: `@slop-lab/${name}`, version, file: `${name}.tgz`, requires: {}
  })) };
  await writeFile(join(stage, "package/package.json"), JSON.stringify({ name: "@slop-lab/dim-installer", version: archiveVersion }));
  await run("tar", ["-czf", join(bundle, "dim-installer.tgz"), "-C", stage, "package"]);
  await writeFile(join(bundle, "dim-cli.tgz"), "fixture CLI artifact");
  await writeFile(join(bundle, "dim-host-core.tgz"), "fixture host artifact");
  await writeFile(join(bin, "docker"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  await writeFile(join(bin, "npm"), '#!/bin/sh\nprintf "%s\\n" "$@" > "$DIM_TEST_NPM_ARGS"\nexit 73\n', { mode: 0o700 });
  const execute = async (script: string, input = manifest) => {
    await writeFile(join(bundle, "packages.json"), JSON.stringify(input));
    return run("bash", [join(scripts, script), ...(script.includes("control-plane") ? [runtime] : [])], { env: { ...process.env, GIT_MASTER: "1", PATH: `${bin}:${process.env.PATH ?? ""}`,
      DIM_EXAMPLE_PACKAGE_BUNDLE: bundle, DIM_EXAMPLE_REMOTE_SETUP: root, DIM_EXAMPLE_DIM_BIN: "", DIM_TEST_NPM_ARGS: marker }, timeout: 10_000 })
      .then((result) => ({ code: 0, ...result }), (error: unknown) => {
        if (!(error instanceof Error) || !("code" in error) || !("stderr" in error)) throw error;
        return { code: error.code, stderr: String(error.stderr), stdout: "" };
      });
  };
  return { bundle, marker, manifest, execute, runtime };
}

it.each([
  { script: "verify-installed.bash", version: "0.10.0" },
  { script: "verify-installed.bash", version: `0.10.0-local-${"a".repeat(64)}` },
  { script: "prepare-installed-control-plane.bash", version: "0.10.0" },
  { script: "prepare-installed-control-plane.bash", version: `0.10.0-local-${"a".repeat(64)}` }
])("hands the selected exact installer to npm ($script/$version)", async ({ script, version }) => {
  const f = await fixture(version), result = await f.execute(script);
  expect(result.code).toBe(73);
  expect((await readFile(f.marker, "utf8")).trim().split("\n").at(-1)).toBe(join(f.bundle, "dim-installer.tgz"));
  await expect(access(join(f.runtime, "prepared"))).rejects.toMatchObject({ code: "ENOENT" });
});

it("refuses service startup from an unprepared runtime without running an installer", async () => {
  const f = await fixture("0.10.0"), result = await f.execute("serve-installed-control-plane.bash");
  expect(result.code).toBe(2);
  expect(result.stderr).toContain("no matching completed preparation");
  await expect(access(f.marker)).rejects.toMatchObject({ code: "ENOENT" });
});

const invalid: readonly { readonly label: string; readonly change: (manifest: Manifest) => Manifest }[] = [
  { label: "schema", change: (m) => ({ ...m, schemaVersion: 2 }) },
  { label: "duplicate", change: (m) => ({ ...m, packages: [...m.packages, ...m.packages.filter(({ name }) => name.endsWith("dim-installer"))] }) },
  { label: "installer skew", change: (m) => ({ ...m, packages: m.packages.map((p) => p.name.endsWith("dim-installer") ? { ...p, version: "0.9.0" } : p) }) },
  { label: "core skew", change: (m) => ({ ...m, packages: m.packages.map((p) => p.name.endsWith("dim-host-core") ? { ...p, version: "0.9.0" } : p) }) },
  { label: "missing dependency", change: (m) => ({ ...m, packages: m.packages.map((p) => p.name.endsWith("dim-host-core") ? { ...p, requires: { "@slop-lab/missing": p.version } } : p) }) },
  { label: "escaped artifact", change: (m) => ({ ...m, packages: m.packages.map((p) => p.name.endsWith("dim-installer") ? { ...p, file: "../outside.tgz" } : p) }) },
  { label: "floating version", change: (m) => ({ ...m, packages: m.packages.map((p) => ({ ...p, version: "latest" })) }) }
];
it.each(invalid)("rejects $label before package installation", async ({ change }) => {
  const f = await fixture("0.10.0"), result = await f.execute("verify-installed.bash", change(f.manifest));
  expect(result.code).not.toBe(0); expect(result.code).not.toBe(73);
  await expect(access(f.marker)).rejects.toMatchObject({ code: "ENOENT" });
});

it("rejects an installer archive whose package version differs from its manifest", async () => {
  const f = await fixture("0.10.0", "0.9.0"), result = await f.execute("verify-installed.bash");
  expect(result.code).not.toBe(73);
  await expect(access(f.marker)).rejects.toMatchObject({ code: "ENOENT" });
});

it("keeps recipe base-version pins and rejects unrelated or floating selections", () => {
  const name = "@slop-lab/dim-host-plugin-agent-tools", version = `0.10.0-local-${"c".repeat(64)}`;
  expect(examplePluginSpecifiers([{ name, version }], [`${name}@0.10.0`])).toEqual([`${name}@${version}`]);
  for (const declared of ["0.9.0", "latest"]) expect(() => examplePluginSpecifiers([{ name, version }], [`${name}@${declared}`])).toThrow();
  expect(() => examplePluginSpecifiers([{ name, version: "0.10.0-local-unreviewed" }], [`${name}@0.10.0`])).toThrow();
});
