import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const cli = fileURLToPath(new URL("../../../../core/packages/cli/dist/cli.js", import.meta.url));
const packageDirectory = fileURLToPath(new URL("../../../../core/packages/cli", import.meta.url));

type ImageFixture = {
  readonly root: string;
  readonly env: NodeJS.ProcessEnv;
  readonly commandLog: string;
};

test("workspace image build uses shipped context without controller or backend configuration", async () => {
  const fixture = await createFixture("build");
  try {
    const result = run(["workspace", "image", "build"], {
      ...fixture.env,
      DIM_CONFIG_PATH: path.join(fixture.root, "missing.json"),
      DIM_WORKSPACE_IMAGE: undefined
    });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "Built workspace image 'dev-infra-project-workspace:0.10.0' on 'local'\n");
    const log = await readFile(fixture.commandLog, "utf8");
    assert.match(log, /^docker buildx build --load --build-arg DIM_UID=\d+ --build-arg DIM_GID=\d+ --tag dev-infra-project-workspace:0\.10\.0 --file Dockerfile \.\n$/);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("workspace image build rejects immutable destinations before Docker", async () => {
  const fixture = await createFixture("build");
  try {
    const result = run(["workspace", "image", "build"], {
      ...fixture.env,
      DIM_WORKSPACE_IMAGE: `workspace@sha256:${"a".repeat(64)}`
    });

    assert.equal(result.status, 2);
    assert.match(result.stderr, /build destination must be an image repository\/tag, not a digest/);
    assert.equal(result.stdout, "");
    assert.equal(await readFile(fixture.commandLog, "utf8"), "");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

async function createFixture(status: "build"): Promise<ImageFixture> {
  const root = await mkdtemp(path.join(tmpdir(), "dim-workspace-image-"));
  const bin = path.join(root, "bin");
  const commandLog = path.join(root, "commands.log");
  await mkdir(bin);
  await writeFile(commandLog, "");
  await writeFile(path.join(bin, "docker"), `#!/bin/sh
set -eu
printf 'docker %s\\n' "$*" >> "$DIM_TEST_COMMAND_LOG"
if [ "$DIM_TEST_IMAGE_STATUS" = build ]; then
  test -f Dockerfile
  test -f agent-entrypoint.bash
  test ! -e controller-proxy
  exit 0
fi
exit 97
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
      DIM_STATE_ROOT: path.join(root, "state"),
      DIM_TEST_COMMAND_LOG: commandLog,
      DIM_TEST_IMAGE_STATUS: status,
      DIM_WORKSPACE_IMAGE: "test-workspace:issue-60"
    }
  };
}

function run(args: readonly string[], env: NodeJS.ProcessEnv = process.env) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd: packageDirectory,
    encoding: "utf8",
    env
  });
}
