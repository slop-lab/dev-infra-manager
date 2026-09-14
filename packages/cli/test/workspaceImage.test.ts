import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const cli = fileURLToPath(new URL("../../../../core/packages/cli/src/cli.ts", import.meta.url));
const packageDirectory = fileURLToPath(new URL("../../../../core/packages/cli", import.meta.url));
const tsxImport = import.meta.resolve("tsx");

type ImageFixture = {
  readonly root: string;
  readonly env: NodeJS.ProcessEnv;
  readonly commandLog: string;
};

const imageId = `sha256:${"a".repeat(64)}`;

test("workspace image status is discoverable with JSON output", () => {
  const workspaceHelp = run(["workspace", "--help"]);
  assert.equal(workspaceHelp.status, 0);
  assert.match(workspaceHelp.stdout, /image/);

  const imageHelp = run(["workspace", "image", "--help"]);
  assert.equal(imageHelp.status, 0);
  assert.match(imageHelp.stdout, /status/);

  const statusHelp = run(["workspace", "image", "status", "--help"]);
  assert.equal(statusHelp.status, 0);
  assert.match(statusHelp.stdout, /--json/);
});

test("workspace image status emits the exact ready JSON without controller side effects", async () => {
  const fixture = await createFixture("ready");
  try {
    const result = run(["workspace", "image", "status", "--json"], fixture.env);

    assert.equal(result.status, 0);
    assert.equal(result.stdout, `{"status":"ready","imageId":"${imageId}"}\n`);
    assert.equal(result.stderr, "");
    assert.equal(
      await readFile(fixture.commandLog, "utf8"),
      "docker image inspect --format {{.Id}} test-workspace:issue-60\n"
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("workspace image status emits the exact missing JSON", async () => {
  const fixture = await createFixture("missing");
  try {
    const result = run(["workspace", "image", "status", "--json"], fixture.env);

    assert.equal(result.status, 0);
    assert.equal(result.stdout, '{"status":"missing"}\n');
    assert.equal(result.stderr, "");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("workspace image status emits concise human output", async () => {
  const fixture = await createFixture("ready");
  try {
    const result = run(["workspace", "image", "status"], fixture.env);

    assert.equal(result.status, 0);
    assert.equal(result.stdout, `Workspace image is ready: ${imageId}\n`);
    assert.equal(result.stderr, "");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("workspace image status reports a missing image in human output", async () => {
  const fixture = await createFixture("missing");
  try {
    const result = run(["workspace", "image", "status"], fixture.env);

    assert.equal(result.status, 0);
    assert.equal(result.stdout, "Workspace image is missing\n");
    assert.equal(result.stderr, "");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("workspace image status rejects malformed successful image IDs", async () => {
  const fixture = await createFixture("malformed");
  try {
    const result = run(["workspace", "image", "status", "--json"], fixture.env);

    assert.equal(result.status, 2);
    assert.match(result.stderr, /invalid image ID.*\^sha256:\[0-9a-f\]\{64\}\$/);
    assert.equal(result.stdout, "");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("workspace image status requires a configured backend", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dim-workspace-image-unconfigured-"));
  try {
    const result = run(["workspace", "image", "status"], {
      ...process.env,
      DIM_CONFIG_PATH: path.join(root, "missing.json")
    });

    assert.equal(result.status, 2);
    assert.equal(
      result.stderr,
      "workspace backend is not configured in DIM user config; install a host backend first\n"
    );
    assert.equal(result.stdout, "");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function createFixture(status: "ready" | "missing" | "malformed"): Promise<ImageFixture> {
  const root = await mkdtemp(path.join(tmpdir(), "dim-workspace-image-"));
  const bin = path.join(root, "bin");
  const configPath = path.join(root, "config.json");
  const commandLog = path.join(root, "commands.log");
  await mkdir(bin);
  await writeFile(configPath, JSON.stringify({ schemaVersion: 1, workspaceBackend: "sysbox" }));
  await writeFile(commandLog, "");
  await writeFile(path.join(bin, "docker"), `#!/bin/sh
printf 'docker %s\\n' "$*" >> "$DIM_TEST_COMMAND_LOG"
if [ "$DIM_TEST_IMAGE_STATUS" = malformed ]; then
  printf '${imageId}\\n${imageId}\\n'
  exit 0
fi
if [ "$DIM_TEST_IMAGE_STATUS" = ready ]; then
  printf '${imageId}\\n'
  exit 0
fi
printf 'Error response from daemon: No such image: test-workspace:issue-60\\n' >&2
exit 1
`);
  await writeFile(path.join(bin, "systemctl"), `#!/bin/sh
printf 'systemctl %s\\n' "$*" >> "$DIM_TEST_COMMAND_LOG"
exit 97
`);
  await chmod(path.join(bin, "docker"), 0o700);
  await chmod(path.join(bin, "systemctl"), 0o700);
  return {
    root,
    commandLog,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      DIM_CONFIG_PATH: configPath,
      DIM_STATE_ROOT: path.join(root, "state"),
      DIM_TEST_COMMAND_LOG: commandLog,
      DIM_TEST_IMAGE_STATUS: status,
      DIM_WORKSPACE_IMAGE: "test-workspace:issue-60"
    }
  };
}

function run(args: readonly string[], env: NodeJS.ProcessEnv = process.env) {
  return spawnSync(process.execPath, ["--import", tsxImport, cli, ...args], {
    cwd: packageDirectory,
    encoding: "utf8",
    env
  });
}
