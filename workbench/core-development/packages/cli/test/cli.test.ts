import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const cli = fileURLToPath(new URL("../../../../core/packages/cli/src/cli.ts", import.meta.url));
const cliSupport = fileURLToPath(new URL("../../../../core/packages/cli/src/cli-support.ts", import.meta.url));
const packageDirectory = fileURLToPath(new URL("../../../../core/packages/cli", import.meta.url));
const tsxImport = import.meta.resolve("tsx");

test("managed controller restarts preserve the workspace-mounted runtime directory", async () => {
  const source = `${await readFile(cli, "utf8")}\n${await readFile(cliSupport, "utf8")}`;
  assert.match(source, /^RuntimeDirectory=dim$/m);
  assert.match(source, /^RuntimeDirectoryPreserve=restart$/m);
  assert.doesNotMatch(source, /^RuntimeDirectoryPreserve=yes$/m);
  assert.doesNotMatch(
    source,
    /if \(usesSystemdManagedController\(options\)\) \{\s+await stopManagedController/
  );
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

test("repository sync commands expose safe reviewed contracts", () => {
  const fetchHelp = run(["repo", "fetch", "--help"]);
  assert.equal(fetchHelp.status, 0);
  assert.match(fetchHelp.stdout, /--prune/);
  assert.doesNotMatch(fetchHelp.stdout, /--force/);

  const publishHelp = run(["repo", "publish", "--help"]);
  assert.equal(publishHelp.status, 0);
  assert.match(publishHelp.stdout, /<project> \[alias\]/);

  const addHelp = run(["repo", "add", "--help"]);
  assert.equal(addHelp.status, 0);
  assert.match(addHelp.stdout, /--mirror/);

  const invalid = run(["repo", "push", "project", "root", "main"]);
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr, /unknown command 'push'/);
});

test("project create exposes root bootstrap and explicit repository-set choices", () => {
  const help = run(["project", "create", "--help"]);
  assert.equal(help.status, 0);
  for (const option of ["--root <alias>", "--bootstrap-git-url <git-url>", "--bootstrap-git-ref <git-ref>", "--apply-repos", "--no-apply-repos"]) {
    assert.match(help.stdout, new RegExp(option.replace(/[<>]/g, "\\$&")));
  }

  const rootOnlyPolicy = run([
    "project", "create", "example", "--bootstrap-git-url", "https://example.com/root.git", "--protect", "main"
  ]);
  assert.notEqual(rootOnlyPolicy.status, 0);
  assert.match(rootOnlyPolicy.stderr, /--protect and --mirror require --root/);

  const conflictingApply = run([
    "project", "create", "example", "--root", "root", "--apply-repos", "--no-apply-repos"
  ]);
  assert.notEqual(conflictingApply.status, 0);
  assert.match(conflictingApply.stderr, /--apply-repos and --no-apply-repos cannot be used together/);

  const conflictingSources = run([
    "project", "create", "example", "--repos", "repos.yml", "--root", "root"
  ]);
  assert.notEqual(conflictingSources.status, 0);
  assert.match(conflictingSources.stderr, /--repos cannot be combined/);

  for (const obsolete of [["--url", "https://example.com/root.git"], ["--ref", "main"]]) {
    const result = run(["project", "create", "example", ...obsolete]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /unknown option/);
  }
});

test("CI runner commands expose lifecycle and configurable defaults", () => {
  const help = run(["ci", "runner", "--help"]);
  assert.equal(help.status, 0);
  for (const command of ["create", "status", "logs", "start", "restart", "stop", "delete", "defaults"]) {
    assert.match(help.stdout, new RegExp(command));
  }

  const create = run(["ci", "runner", "create", "--help"]);
  assert.equal(create.status, 0);
  assert.match(create.stdout, /--cpus <count>/);
  assert.match(create.stdout, /--memory <size>/);
  assert.match(create.stdout, /--processes <count>/);
  assert.doesNotMatch(create.stdout, /--pids-limit/);
  assert.match(create.stdout, /<project> <runner> <executor>/);

  const invalidExecutor = run(["ci", "runner", "create", "example", "primary", "other"]);
  assert.notEqual(invalidExecutor.status, 0);
  assert.match(invalidExecutor.stderr, /must be 'sysbox' or 'qemu'/);

  const qemuProcesses = run(["ci", "runner", "create", "example", "release", "qemu", "--processes", "512"]);
  assert.notEqual(qemuProcesses.status, 0);
  assert.match(qemuProcesses.stderr, /--processes applies only to the sysbox executor/);

  const defaults = run(["ci", "runner", "defaults", "set", "--help"]);
  assert.equal(defaults.status, 0);
  assert.match(defaults.stdout, /--cpus <count>/);

  const missingDefaults = run(["ci", "runner", "defaults", "set"]);
  assert.notEqual(missingDefaults.status, 0);
  assert.match(missingDefaults.stderr, /required option/);
});

test("workspace resources command requires at least one live limit", () => {
  const workspaceHelp = run(["workspace", "--help"]);
  assert.equal(workspaceHelp.status, 0);
  for (const command of ["align", "create", "discard", "resources", "update"]) {
    assert.match(workspaceHelp.stdout, new RegExp(command));
  }

  const removedRoot = run(["resources", "work-1"]);
  assert.notEqual(removedRoot.status, 0);
  assert.match(removedRoot.stderr, /unknown command 'resources'/);

  const help = run(["workspace", "resources", "--help"]);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /--cpus <count>/);
  assert.match(help.stdout, /--memory <size>/);
  assert.match(help.stdout, /--processes <count>/);
  assert.doesNotMatch(help.stdout, /--pids-limit/);

  const missing = run(["workspace", "resources", "work-1"]);
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /provide at least one resource limit/);

  const unsafeAlign = run(["workspace", "align", "work-1", "--reset"]);
  assert.notEqual(unsafeAlign.status, 0);
  assert.match(unsafeAlign.stderr, /--reset requires --yes/);
});

test("workspace creation exposes explicit KVM policy", () => {
  const help = run(["workspace", "create", "--help"]);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /--kvm/);
  assert.match(help.stdout, /--no-kvm/);
});

test("destructive commands require --yes only in non-interactive use", () => {
  for (const args of [
    ["project", "purge", "example"],
    ["repo", "delete", "example", "root"],
    ["ci", "runner", "delete", "example", "primary"],
    ["workspace", "discard", "work-1"]
  ]) {
    const result = run(args);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /confirmation requires --yes in a non-interactive shell/);
    assert.doesNotMatch(result.stderr, /required option '--yes'/);
  }
});

test("controller serve preserves the active owner and cleans up its runtime files", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dim-controller-test-"));
  const socket = path.join(root, "controller.sock");
  const adminSocket = path.join(root, "admin.sock");
  const pidPath = path.join(root, "controller.pid");
  const configHome = path.join(root, "config");
  await mkdir(path.join(configHome, "dim"), { recursive: true });
  await writeFile(
    path.join(configHome, "dim", "config.json"),
    `${JSON.stringify({ schemaVersion: 1, workspaceBackend: "runc" })}\n`
  );
  const args = [
    "--import",
    tsxImport,
    cli,
    "controller",
    "serve",
    "--socket",
    socket,
    "--admin-socket",
    adminSocket
  ];
  const env = {
    ...process.env,
    DIM_ADMIN_CONTROLLER_SOCKET: adminSocket,
    DIM_CONTROLLER_SOCKET: socket,
    DIM_PLUGIN_HOME: path.join(root, "plugins"),
    DIM_STATE_ROOT: path.join(root, "state"),
    XDG_CONFIG_HOME: configHome
  };
  const controller = spawn(process.execPath, args, {
    cwd: packageDirectory,
    env,
    stdio: ["ignore", "pipe", "pipe"]
  });
  try {
    await waitForPath(pidPath);
    assert.equal(Number((await readFile(pidPath, "utf8")).trim()), controller.pid);

    const duplicate = spawn(process.execPath, args, {
      cwd: packageDirectory,
      env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    const [code] = await Promise.race([
      once(duplicate, "exit"),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("duplicate controller did not exit")), 5_000))
    ]);
    assert.equal(code, 2);
    assert.equal(Number((await readFile(pidPath, "utf8")).trim()), controller.pid);
  } finally {
    if (controller.exitCode === null) {
      controller.kill("SIGTERM");
      await once(controller, "exit");
    }
  }

  try {
    await assert.rejects(access(pidPath), { code: "ENOENT" });
    await assert.rejects(access(socket), { code: "ENOENT" });
    await assert.rejects(access(adminSocket), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function run(args: string[]): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, ["--import", tsxImport, cli, ...args], {
    cwd: packageDirectory,
    encoding: "utf8"
  });
}

async function waitForPath(target: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      await access(target);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  throw new Error(`timed out waiting for ${target}`);
}
