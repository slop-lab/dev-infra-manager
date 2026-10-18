import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { adminErrorDetail, printActionResult } from "../../../../core/packages/cli/src/cli-support.js";
import { cliSourceCycles, readCliSource } from "./sourceArchitecture.js";

const cli = fileURLToPath(new URL("../../../../core/packages/cli/src/cli.ts", import.meta.url));
const cliSupport = fileURLToPath(new URL("../../../../core/packages/cli/src/cli-support.ts", import.meta.url));
const packageDirectory = fileURLToPath(new URL("../../../../core/packages/cli", import.meta.url));
const tsxImport = import.meta.resolve("tsx");
const sourceRepositoryUrl = "https://github.com/slop-lab/dev-infra-manager";

test("root help identifies the canonical source repository", () => {
  const help = run(["--help"]);
  assert.equal(help.status, 0);
  assert.match(help.stdout, new RegExp(sourceRepositoryUrl.replaceAll("/", "\\/")));
  assert.doesNotMatch(help.stdout, /dim repo/);
});

test("install-cp is not implemented by the DIM CLI", () => {
  const help = run(["--help"]);
  assert.doesNotMatch(help.stdout, /install-cp/);

  const result = run(["install-cp"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /unknown command ['"]install-cp['"]/);
});

test("managed controller restarts preserve the workspace-mounted runtime directory", async () => {
  const source = await readCliSource("systemd-controller", "managed-controller");
  const entryAndBarrel = `${await readFile(cli, "utf8")}\n${await readFile(cliSupport, "utf8")}`;
  assert.match(source, /^RuntimeDirectory=dim$/m);
  assert.match(source, /^RuntimeDirectoryPreserve=restart$/m);
  assert.doesNotMatch(source, /^RuntimeDirectoryPreserve=yes$/m);
  const restartSource = source.slice(source.indexOf("export async function restartManagedController"));
  assert.doesNotMatch(
    restartSource,
    /if \(usesSystemdManagedController\(options\)\) \{\s+await stopManagedController/
  );
  assert.doesNotMatch(entryAndBarrel, /Static source-contract inventory/);
  assert.deepEqual(await cliSourceCycles(), []);
});

test("controller errors preserve useful messages", () => {
  assert.equal(adminErrorDetail('{"error":"setup failed safely"}'), "setup failed safely");
  assert.equal(adminErrorDetail("plain failure"), "plain failure");
});

test("common workspace commands are available directly and in the workspace group", () => {
  const rootHelp = run(["--help"]);
  assert.equal(rootHelp.status, 0);
  for (const command of ["create", "list", "show", "resources", "setup", "start", "stop", "restart", "update", "discard", "exec", "run"]) {
    assert.match(rootHelp.stdout, new RegExp(`\\b${command}\\b`));
    const root = run([command, "--help"]);
    const grouped = run(["workspace", command, "--help"]);
    assert.equal(root.status, 0);
    assert.equal(grouped.status, 0);
    assert.equal(root.stdout, grouped.stdout.replace("Usage: dim workspace ", "Usage: dim "));
  }
  const list = run(["ls", "--help"]);
  assert.equal(list.status, 0);
  assert.match(list.stdout, /--json/);
  assert.match(list.stdout, /List workspaces/);
});

test("workspace actions hide lifecycle records unless JSON is requested", () => {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...items: unknown[]) => lines.push(items.map(String).join(" "));
  try {
    const record = { name: "work-1", phase: "ready", internal: { token: "secret" } };
    printActionResult(record, {}, "Restarted workspace 'work-1'");
    assert.deepEqual(lines, ["Restarted workspace 'work-1'"]);
    lines.length = 0;
    printActionResult(record, { json: true }, "Restarted workspace 'work-1'");
    assert.equal(lines.length, 1);
    const [line] = lines;
    assert.ok(line);
    assert.deepEqual(JSON.parse(line), record);
  } finally {
    console.log = original;
  }
});

test("DNS provider add passes extra arguments to the selected plugin driver", () => {
  const help = run(["external-url", "dns-provider", "add", "cloudflare", "--help"]);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /--name <name>/);
  assert.match(help.stdout, /\[driver-argument\.\.\.\]/);
  assert.doesNotMatch(help.stdout, /--argument <string>/);
  assert.doesNotMatch(help.stdout, /--zone|--record-type|--target|--credential-env/);

  const missingName = run(["external-url", "dns-provider", "add", "cloudflare"]);
  assert.notEqual(missingName.status, 0);
  assert.match(missingName.stderr, /required option '--name <name>' not specified/);
});

test("repository namespace is unavailable after the native-only cutover", () => {
  for (const args of [
    ["repo", "list", "project"],
    ["x", "git", "status"],
    ["git", "setup"],
    ["admin", "service", "ensure"]
  ]) {
    const result = run(args);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /unknown command/);
  }
});

test("project commands expose only native bootstrap, create, list, and show", () => {
  const projectHelp = run(["project", "--help"]);
  assert.equal(projectHelp.status, 0);
  for (const command of ["bootstrap-native-root", "create", "list", "show"]) {
    assert.match(projectHelp.stdout, new RegExp(command));
  }
  assert.doesNotMatch(projectHelp.stdout, /\bremove\b|\bpurge\b/);

  const help = run(["project", "create", "--help"]);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /--json/);
  assert.doesNotMatch(help.stdout, /--repos|--root|--bootstrap-git-url|--protect|--mirror|--apply-repos/);

  const missingNativeSelection = run(["project", "list"]);
  assert.equal(missingNativeSelection.status, 2);
  assert.match(missingNativeSelection.stderr, /DIM_NATIVE_CONTROL_PLANE_CONNECTION_FILE is required/);
});

test("CI exposes only native execution families", () => {
  const help = run(["ci", "--help"]);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /native-root/);
  assert.match(help.stdout, /native-qemu/);
  assert.doesNotMatch(help.stdout, /ordinary-pool|runner|scheduler/);
  for (const command of ["runner", "ordinary-pool", "scheduler"]) {
    const result = run(["ci", command]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, new RegExp(`unknown command '${command}'`));
  }
});

test("native root CI exposes host execution without manual Project admission", () => {
  // Given
  const help = run(["ci", "native-root", "--help"]);

  // When
  const host = run(["ci", "native-root", "host", "run", "--help"]);

  // Then
  assert.equal(help.status, 0);
  assert.match(help.stdout, /host/);
  assert.doesNotMatch(help.stdout, /project/);
  assert.equal(host.status, 0);
  assert.match(host.stdout, /<config>/);
});

test("native QEMU exposes scheduler, runner image, host, and event operations", () => {
  const help = run(["ci", "native-qemu", "--help"]);
  assert.equal(help.status, 0);
  for (const command of ["scheduler", "runner", "host", "event"]) {
    assert.match(help.stdout, new RegExp(command));
  }
});

test("host lifecycle commands expose volume-preserving maintenance", () => {
  const help = run(["host", "--help"]);
  assert.equal(help.status, 0);
  for (const command of ["status", "shutdown", "start"]) {
    assert.match(help.stdout, new RegExp(command));
  }
  const shutdown = run(["host", "shutdown", "--help"]);
  assert.equal(shutdown.status, 0);
  assert.match(shutdown.stdout, /preserving all managed volumes/);
});

test("workspace resources command requires at least one live limit", () => {
  const workspaceHelp = run(["workspace", "--help"]);
  assert.equal(workspaceHelp.status, 0);
  for (const command of ["create", "discard", "resources", "update"]) {
    assert.match(workspaceHelp.stdout, new RegExp(command));
  }
  assert.doesNotMatch(workspaceHelp.stdout, /\balign\b/);

  const help = run(["workspace", "resources", "--help"]);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /--cpus <count>/);
  assert.match(help.stdout, /--memory <size>/);
  assert.match(help.stdout, /--pids <count>/);
  assert.doesNotMatch(help.stdout, /--processes/);
  assert.doesNotMatch(help.stdout, /--pids-limit/);

  for (const prefix of [[], ["workspace"]]) {
    const missing = run([...prefix, "resources", "work-1"]);
    assert.notEqual(missing.status, 0);
    assert.match(missing.stderr, /provide at least one resource limit/);
  }

});

test("workspace creation exposes explicit KVM policy", () => {
  const help = run(["workspace", "create", "--help"]);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /--kvm/);
  assert.match(help.stdout, /--no-kvm/);
  assert.doesNotMatch(help.stdout, /--repo-ref/);
  assert.match(help.stdout, /--require-capability <name>/);
  assert.match(help.stdout, /--recommend-capability <name>/);
  const obsoleteRepoRef = run(["workspace", "create", "project", "work-1", "--repo-ref", "app=main"]);
  assert.notEqual(obsoleteRepoRef.status, 0);
  assert.match(obsoleteRepoRef.stderr, /unknown option '--repo-ref'/);
  const discardHelp = run(["workspace", "discard", "--help"]);
  assert.equal(discardHelp.status, 0);
  assert.match(discardHelp.stdout, /--keep-volume/);
});

test("destructive commands require --yes only in non-interactive use", () => {
  for (const args of [
    ["workspace", "discard", "work-1"]
  ]) {
    const result = run(args);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /confirmation requires --yes in a non-interactive shell/);
    assert.doesNotMatch(result.stderr, /required option '--yes'/);
  }

  const obsoleteAlign = run(["workspace", "align", "work-1", "--reset"]);
  assert.notEqual(obsoleteAlign.status, 0);
  assert.match(obsoleteAlign.stderr, /unknown command 'align'/);
});

test("workspace discard prompts in an interactive terminal", () => {
  const command = [
    process.execPath,
    "--import",
    tsxImport,
    cli,
    "workspace",
    "discard",
    "work-1"
  ].map(shellArgument).join(" ");
  const result = spawnSync("script", ["--quiet", "--return", "--command", command, "/dev/null"], {
    cwd: packageDirectory,
    input: "n\n",
    encoding: "utf8"
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /Permanently discard workspace 'work-1'\? \[y\/N\]/);
  assert.match(result.stdout, /operation was not confirmed/);
  assert.doesNotMatch(result.stdout, /confirmation requires --yes/);
});

function run(args: string[]): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, ["--import", tsxImport, cli, ...args], {
    cwd: packageDirectory,
    encoding: "utf8"
  });
}

function shellArgument(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
