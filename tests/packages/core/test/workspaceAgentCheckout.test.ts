import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execute = promisify(execFile);
const script = join(import.meta.dirname, "../../../../core/images/project-workspace/agent-checkout.bash");

describe("recommended workspace checkout", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("retains dirty work as a usable checkout when the protected root advances", async () => {
    const root = await mkdtemp(join(tmpdir(), "dim-agent-checkout-"));
    roots.push(root);
    const source = join(root, "source");
    const checkout = join(root, "checkout");
    await execute("git", ["init", source]);
    await execute("git", ["-C", source, "config", "user.name", "Test"]);
    await execute("git", ["-C", source, "config", "user.email", "test@example.invalid"]);
    await writeFile(join(source, "file.txt"), "first\n");
    await execute("git", ["-C", source, "add", "file.txt"]);
    await execute("git", ["-C", source, "commit", "-m", "first"]);
    const first = (await execute("git", ["-C", source, "rev-parse", "HEAD"])).stdout.trim();
    await mkdir(checkout);
    await runCheckout(checkout, source, first);
    await writeFile(join(checkout, "local.txt"), "preserve\n");
    await writeFile(join(source, "file.txt"), "second\n");
    await execute("git", ["-C", source, "commit", "-am", "second"]);
    const second = (await execute("git", ["-C", source, "rev-parse", "HEAD"])).stdout.trim();

    const result = await runCheckout(checkout, source, second);

    expect(result.stderr).toMatch(/retained checkout.*git fetch.*merge.*rebase/i);
    await expect(readFile(join(checkout, "local.txt"), "utf8")).resolves.toBe("preserve\n");
    await expect(readFile(join(checkout, ".git", "dim-root-commit"), "utf8")).resolves.toBe(`${first}\n`);
    await expect(execute("git", ["-C", checkout, "rev-parse", "HEAD"]))
      .resolves.toMatchObject({ stdout: `${first}\n` });
    await expect(execute("git", ["-C", checkout, "config", "--get-all", "remote.origin.push"]))
      .resolves.toMatchObject({ stdout: "HEAD:refs/heads/proposals/workspace-id/workspace\n" });
  });

  it("leaves an empty volume retryable when the first fetch fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "dim-agent-checkout-retry-"));
    roots.push(root);
    const source = join(root, "source");
    const checkout = join(root, "checkout");
    const commit = await createCommit(source, "file.txt", "content\n", "root");
    await mkdir(checkout);

    await expect(runCheckout(checkout, join(root, "missing"), commit)).rejects.toBeDefined();
    await expect(execute("find", [checkout, "-mindepth", "1", "-maxdepth", "1", "-print"]))
      .resolves.toMatchObject({ stdout: "" });
    await runCheckout(checkout, source, commit);
    await expect(readFile(join(checkout, ".git", "dim-workspace-id"), "utf8"))
      .resolves.toBe("workspace-id\n");
  });

  it("resumes an owned initial publication after interruption", async () => {
    // Given
    const root = await mkdtemp(join(tmpdir(), "dim-agent-checkout-publish-"));
    roots.push(root);
    const source = join(root, "source");
    const checkout = join(root, "checkout");
    const shimRoot = join(root, "bin");
    const commit = await createCommit(source, "first.txt", "first\n", "root");
    await writeFile(join(source, "second.txt"), "second\n");
    await execute("git", ["-C", source, "add", "second.txt"]);
    await execute("git", ["-C", source, "commit", "-m", "second"]);
    const completeCommit = (await execute("git", ["-C", source, "rev-parse", "HEAD"])).stdout.trim();
    expect(completeCommit).not.toBe(commit);
    await mkdir(checkout);
    await mkdir(shimRoot);
    await writeFile(join(shimRoot, "mv"), `#!/usr/bin/env bash
set -euo pipefail
sources=()
after_options=false
for argument in "$@"; do
  if [[ "$after_options" == false && "$argument" == "--" ]]; then
    after_options=true
  elif [[ "$after_options" == true ]]; then
    sources+=("$argument")
  fi
done
destination="\${sources[-1]}"
/usr/bin/mv -- "\${sources[0]}" "$destination"
kill -KILL "$PPID"
`);
    await chmod(join(shimRoot, "mv"), 0o755);

    // When
    await expect(execute("bash", [script], {
      cwd: checkout,
      env: { ...checkoutEnvironment(source, completeCommit), PATH: `${shimRoot}:${process.env.PATH ?? ""}` }
    })).rejects.toBeDefined();
    await runCheckout(checkout, source, completeCommit);

    // Then
    await expect(readFile(join(checkout, "first.txt"), "utf8")).resolves.toBe("first\n");
    await expect(readFile(join(checkout, "second.txt"), "utf8")).resolves.toBe("second\n");
    await expect(execute("git", ["-C", checkout, "status", "--porcelain=v1"]))
      .resolves.toMatchObject({ stdout: "" });
  });

  it("preserves a concurrent tracked mutation while retaining the checkout", async () => {
    // Given
    const root = await mkdtemp(join(tmpdir(), "dim-agent-checkout-concurrent-"));
    roots.push(root);
    const source = join(root, "source");
    const checkout = join(root, "checkout");
    const shimRoot = join(root, "bin");
    const first = await createCommit(source, "file.txt", "first\n", "first");
    await mkdir(checkout);
    await runCheckout(checkout, source, first);
    await writeFile(join(source, "file.txt"), "second\n");
    await execute("git", ["-C", source, "commit", "-am", "second"]);
    const second = (await execute("git", ["-C", source, "rev-parse", "HEAD"])).stdout.trim();
    await mkdir(shimRoot);
    await writeFile(join(shimRoot, "git"), `#!/usr/bin/env bash
set -euo pipefail
if [[ "$*" == "remote get-url origin" ]]; then
  output="$(/usr/bin/git "$@")"
  printf 'concurrent\n' > "${checkout}/file.txt"
  printf '%s\n' "$output"
else
  exec /usr/bin/git "$@"
fi
`);
    await chmod(join(shimRoot, "git"), 0o755);

    // When
    const result = await execute("bash", [script], {
      cwd: checkout,
      env: { ...checkoutEnvironment(source, second), PATH: `${shimRoot}:${process.env.PATH ?? ""}` }
    });

    // Then
    expect(result.stderr).toMatch(/retained checkout/i);
    await expect(readFile(join(checkout, "file.txt"), "utf8")).resolves.toBe("concurrent\n");
    await expect(readFile(join(checkout, ".git", "dim-root-commit"), "utf8")).resolves.toBe(`${first}\n`);
    await expect(execute("git", ["-C", checkout, "rev-parse", "HEAD"]))
      .resolves.toMatchObject({ stdout: `${first}\n` });
  });

  it("preserves ignored data when the protected root advances", async () => {
    const root = await mkdtemp(join(tmpdir(), "dim-agent-checkout-ignored-"));
    roots.push(root);
    const source = join(root, "source");
    const checkout = join(root, "checkout");
    const first = await createCommit(source, ".gitignore", "cache/\n", "root");
    await mkdir(checkout);
    await runCheckout(checkout, source, first);
    await mkdir(join(checkout, "cache"));
    await writeFile(join(checkout, "cache", "artifact"), "preserve\n");
    await rm(join(source, ".gitignore"));
    await mkdir(join(source, "cache"));
    await writeFile(join(source, "cache", "artifact"), "replacement\n");
    await execute("git", ["-C", source, "add", "-A"]);
    await execute("git", ["-C", source, "commit", "-m", "collision"]);
    const second = (await execute("git", ["-C", source, "rev-parse", "HEAD"])).stdout.trim();

    const result = await runCheckout(checkout, source, second);

    expect(result.stderr).toMatch(/retained checkout/i);
    await expect(readFile(join(checkout, "cache", "artifact"), "utf8")).resolves.toBe("preserve\n");
    await expect(readFile(join(checkout, ".git", "dim-root-commit"), "utf8")).resolves.toBe(`${first}\n`);
  });
});

async function createCommit(source: string, path: string, contents: string, message: string): Promise<string> {
  await execute("git", ["init", source]);
  await execute("git", ["-C", source, "config", "user.name", "Test"]);
  await execute("git", ["-C", source, "config", "user.email", "test@example.invalid"]);
  await writeFile(join(source, path), contents);
  await execute("git", ["-C", source, "add", path]);
  await execute("git", ["-C", source, "commit", "-m", message]);
  return (await execute("git", ["-C", source, "rev-parse", "HEAD"])).stdout.trim();
}

async function runCheckout(checkout: string, source: string, commit: string): Promise<CheckoutResult> {
  return execute("bash", [script], {
    cwd: checkout,
    env: checkoutEnvironment(source, commit)
  });
}

type CheckoutResult = {
  readonly stdout: string;
  readonly stderr: string;
};

function checkoutEnvironment(source: string, commit: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    DIM_AGENT_REPOSITORY_URL: source,
    DIM_AGENT_ROOT_COMMIT: commit,
    DIM_AGENT_WORKSPACE_ID: "workspace-id",
    GIT_AUTHOR_NAME: "Agent",
    GIT_AUTHOR_EMAIL: "agent@example.invalid"
  };
}
