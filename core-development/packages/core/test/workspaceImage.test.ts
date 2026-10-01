import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { UserError } from "../../../../core/packages/core/src/errors.js";
import { buildWorkspaceImage, inspectWorkspaceImage } from "../../../../core/packages/core/src/index.js";
import { lifecycleOptionsForBackend } from "../../../../core/packages/core/src/lifecycleOptions.js";
import type { CommandResult, CommandRunner, RunOptions } from "../../../../core/packages/core/src/types.js";

const canonicalWorkspaceImageAssets = path.resolve(import.meta.dirname, "../../../../core/images/project-workspace");
const shippedWorkspaceImageAssets = path.resolve(import.meta.dirname, "../../../../core/packages/core/src/workspace-image-assets");
const workspaceImageHelperAssets = [
  "entrypoint.bash",
  "git-askpass.sh",
  "project-cgroup.bash",
  "route-relay.mjs"
] as const;

function normalizeDockerfileCopySources(dockerfile: string): string {
  return dockerfile
    .replace(/^COPY core\/images\/project-workspace\//gm, "COPY ")
    .replace(/^COPY core\/packages\/controller-proxy\/dist /gm, "COPY controller-proxy ");
}

class InspectRunner implements CommandRunner {
  readonly calls: Array<{ readonly command: string; readonly args: readonly string[] }> = [];

  constructor(private readonly result: CommandResult) {}

  async run(command: string, args: string[], _options: RunOptions = {}): Promise<CommandResult> {
    this.calls.push({ command, args });
    return this.result;
  }
}

class BuildRunner implements CommandRunner {
  readonly calls: Array<{ readonly command: string; readonly args: readonly string[]; readonly cwd: string | undefined }> = [];
  readonly contextFiles: string[] = [];

  constructor(private readonly result: CommandResult = commandResult(0)) {}

  async run(command: string, args: string[], options: RunOptions = {}): Promise<CommandResult> {
    this.calls.push({ command, args, cwd: options.cwd });
    if (options.cwd !== undefined) {
      const expectedFiles = [
        "Dockerfile",
        "entrypoint.bash",
        "git-askpass.sh",
        "project-cgroup.bash",
        "route-relay.mjs",
        "controller-proxy/package.json",
        "controller-proxy/cli.js",
        "controller-proxy/development-service-cli.js"
      ];
      for (const relativePath of expectedFiles) {
        await access(path.join(options.cwd, relativePath));
        this.contextFiles.push(relativePath);
      }
      const dockerfile = await readFile(path.join(options.cwd, "Dockerfile"), "utf8");
      expect(dockerfile).toContain("COPY controller-proxy /usr/local/lib/dim/controller-proxy");
    }
    return this.result;
  }
}

function commandResult(exitCode: number, stdout = "", stderr = ""): CommandResult {
  return { command: "docker", args: [], stdout, stderr, exitCode };
}

describe("workspace image asset parity", () => {
  it.each(workspaceImageHelperAssets)("keeps shipped %s bytes identical to the canonical image asset", async (asset) => {
    const [canonical, shipped] = await Promise.all([
      readFile(path.join(canonicalWorkspaceImageAssets, asset)),
      readFile(path.join(shippedWorkspaceImageAssets, asset))
    ]);

    expect(shipped).toEqual(canonical);
  });

  it("keeps the shipped Dockerfile identical after normalizing only build-context COPY sources", async () => {
    const [canonical, shipped] = await Promise.all([
      readFile(path.join(canonicalWorkspaceImageAssets, "Dockerfile"), "utf8"),
      readFile(path.join(shippedWorkspaceImageAssets, "Dockerfile"), "utf8")
    ]);

    expect(normalizeDockerfileCopySources(shipped)).toBe(normalizeDockerfileCopySources(canonical));
  });

  it("initializes persistent roots without recursively changing descendant ownership", async () => {
    const entrypoint = await readFile(path.join(canonicalWorkspaceImageAssets, "entrypoint.bash"), "utf8");

    expect(entrypoint).not.toContain("chown -R");
    expect(entrypoint).toContain('initialize_root /var/lib/dim/workspace-data "workspace data"');
  });

  it("includes Python for repository checks that exercise shipped Python services", async () => {
    const dockerfile = await readFile(path.join(canonicalWorkspaceImageAssets, "Dockerfile"), "utf8");

    expect(dockerfile).toMatch(/apk add --no-cache[^\n]*\bpython3\b/);
  });
});

describe("workspace image inspection", () => {
  const imageId = `sha256:${"a".repeat(64)}`;
  const options = lifecycleOptionsForBackend("sysbox", {
    DIM_WORKSPACE_IMAGE: "example/workspace:tested"
  });

  it("returns the image ID when the configured image exists", async () => {
    const runner = new InspectRunner(commandResult(0, `${imageId}\n`));

    const status = await inspectWorkspaceImage(runner, "sysbox", options);

    expect(status).toEqual({ status: "ready", imageId });
    expect(runner.calls).toEqual([{
      command: "docker",
      args: ["image", "inspect", "--format", "{{.Id}}", "example/workspace:tested"]
    }]);
  });

  it.each([
    "sha256:abc123",
    `sha256:${"A".repeat(64)}`,
    `md5:${"a".repeat(64)}`,
    `${imageId} extra`,
    `${imageId}\n${imageId}`,
  ])("rejects malformed successful Docker image ID %j", async (stdout) => {
    const runner = new InspectRunner(commandResult(0, stdout));

    const inspection = inspectWorkspaceImage(runner, "sysbox", options);

    await expect(inspection).rejects.toBeInstanceOf(UserError);
    await expect(inspection).rejects.toThrow(/invalid image ID.*\^sha256:\[0-9a-f\]\{64\}\$/);
  });

  it("returns missing for Docker's image-not-found result", async () => {
    const runner = new InspectRunner(commandResult(
      1,
      "",
      "Error response from daemon: No such image: example/workspace:tested\n"
    ));

    const status = await inspectWorkspaceImage(runner, "sysbox", options);

    expect(status).toEqual({ status: "missing" });
  });

  it("surfaces other inspection failures as user errors", async () => {
    const runner = new InspectRunner(commandResult(1, "", "permission denied\n"));

    const inspection = inspectWorkspaceImage(runner, "sysbox", options);

    await expect(inspection).rejects.toBeInstanceOf(UserError);
    await expect(inspection).rejects.toThrow("failed to inspect workspace image 'example/workspace:tested': permission denied");
  });
});

describe("workspace image build", () => {
  it("builds the exact installed-version tag from shipped assets and the current user identity", async () => {
    const runner = new BuildRunner();

    const result = await buildWorkspaceImage(runner, {});

    expect(result).toEqual({ image: "dev-infra-project-workspace:0.9.0" });
    expect(runner.calls).toEqual([{
      command: "docker",
      args: [
        "buildx", "build", "--load",
        "--build-arg", `DIM_UID=${process.getuid?.()}`,
        "--build-arg", `DIM_GID=${process.getgid?.()}`,
        "--tag", "dev-infra-project-workspace:0.9.0",
        "--file", "Dockerfile", "."
      ],
      cwd: expect.stringContaining("dim-workspace-image-")
    }]);
    expect(runner.contextFiles).toHaveLength(8);
  });

  it("uses an explicitly tagged workspace image override", async () => {
    const runner = new BuildRunner();

    const result = await buildWorkspaceImage(runner, { DIM_WORKSPACE_IMAGE: "registry.example/dim/workspace:reviewed" });

    expect(result).toEqual({ image: "registry.example/dim/workspace:reviewed" });
    expect(runner.calls[0]?.args).toContain("registry.example/dim/workspace:reviewed");
  });

  it.each([
    "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "registry.example/workspace@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "registry.example/workspace",
    "registry.example/workspace:latest"
  ])("rejects unsafe build destination %j before invoking Docker", async (image) => {
    const runner = new BuildRunner();

    const build = buildWorkspaceImage(runner, { DIM_WORKSPACE_IMAGE: image });

    await expect(build).rejects.toBeInstanceOf(UserError);
    expect(runner.calls).toEqual([]);
  });

  it("reports Docker build failures and removes the temporary context", async () => {
    const runner = new BuildRunner(commandResult(1, "", "build denied\n"));

    const build = buildWorkspaceImage(runner, {});

    await expect(build).rejects.toThrow("failed to build workspace image 'dev-infra-project-workspace:0.9.0': build denied");
    const context = runner.calls[0]?.cwd;
    expect(context).toBeDefined();
    await expect(access(context ?? "")).rejects.toMatchObject({ code: "ENOENT" });
  });
});
