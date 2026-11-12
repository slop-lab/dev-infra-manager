import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const hostMain = fileURLToPath(new URL("../../../../../packages/host/core/src/application/host-main.ts", import.meta.url));
const loader = fileURLToPath(new URL("../../../../node_modules/tsx/dist/loader.mjs", import.meta.url));

test("doctor JSON reports an exact recorded Sysbox time namespace startup failure", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dim-doctor-"));
  try {
    const bin = path.join(root, "bin");
    const state = path.join(root, "state");
    await mkdir(path.join(state, "workspaces"), { recursive: true });
    await mkdir(bin);
    await writeFile(path.join(bin, "git"), "#!/bin/sh\nprintf 'git version 2.51.0\\n'\n");
    await writeFile(path.join(bin, "docker"), `#!/bin/sh
case "$*" in
  "info --format {{json .Runtimes}}") printf '{"sysbox-runc":{}}\\n' ;;
  "image inspect --format {{.Id}} test-workspace:doctor") printf 'sha256:test\\n' ;;
  *) exit 97 ;;
esac
`);
    await chmod(path.join(bin, "git"), 0o700);
    await chmod(path.join(bin, "docker"), 0o700);
    await writeFile(path.join(state, "workspaces/dev.json"), `${JSON.stringify({
      schemaVersion: 10,
      id: "11111111-1111-4111-8111-111111111111",
      name: "dev",
      source: { url: "https://example.test/repository.git", ref: "main", commit: "a".repeat(40) },
      runtime: "container",
      image: "test-workspace:doctor",
      resources: { cpuCount: "2", memory: "4g", pidsLimit: "2048" },
      git: { name: "DIM developer", email: "developer@dim.local" },
      initialized: false,
      phase: "error",
      createdAt: "2026-11-11T00:00:00.000Z",
      updatedAt: "2026-11-11T00:00:01.000Z",
      error: 'at start runtime: namespace {"time" ""} does not exist',
    })}\n`);

    const result = spawnSync(process.execPath, [
      "--disable-warning=DEP0205",
      "--conditions=dim-source",
      "--import",
      loader,
      hostMain,
      "doctor",
      "--json",
    ], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        DIM_STATE_ROOT: state,
        DIM_WORKSPACE_IMAGE: "test-workspace:doctor",
      },
    });

    assert.equal(result.status, 2, result.stderr);
    assert.equal(result.stderr, "");
    const checks: unknown = JSON.parse(result.stdout);
    assert.ok(Array.isArray(checks));
    const compatibility = checks.find((value) => value && typeof value === "object" && "name" in value
      && value.name === "Sysbox startup compatibility");
    assert.deepEqual(Object.keys(compatibility).sort(), ["detail", "name", "ok"]);
    assert.deepEqual(compatibility, {
      name: "Sysbox startup compatibility",
      ok: false,
      detail: "workspace 'dev' recorded the Sysbox startup error 'namespace {\"time\" \"\"} does not exist'. On an idle host, have an operator review Docker daemon configuration for features.time-namespaces=false, validate it, and restart Docker. DIM does not change daemon settings or restart services.",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
