import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const execute = promisify(execFile);
const helper = fileURLToPath(new URL("../../../../packages/host/plugins/agent-tools/src/assets/git-ignore.mjs", import.meta.url));

it("adds other tools' patterns to the user's configured ignore across linked worktrees", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dim-git-ignore-"));
  try {
    const home = path.join(root, "home");
    const checkout = path.join(root, "checkout");
    const worktree = path.join(root, "linked");
    const ignore = path.join(home, "git ignore");
    await mkdir(home);
    await mkdir(checkout);
    await writeFile(ignore, "# existing rule\n.existing");
    const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, ".config"),
      GIT_CONFIG_GLOBAL: path.join(home, ".gitconfig"), GIT_CONFIG_NOSYSTEM: "1" };
    const git = (cwd: string, ...args: string[]) => execute("git", args, { cwd, env });
    await git(checkout, "init", "-q");
    await git(checkout, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-qm", "fixture");
    await git(checkout, "worktree", "add", "--detach", "-q", worktree);
    await git(checkout, "config", "--global", "core.excludesFile", "~/git ignore");

    await Promise.all([checkout, worktree].map(cwd =>
      execute(process.execPath, [helper, ".serena/", ".another-tool/"], { cwd, env }),
    ));
    expect(await readFile(ignore, "utf8")).toBe("# existing rule\n.existing\n.serena/\n.another-tool/\n");
    for (const cwd of [checkout, worktree]) {
      const result = await git(cwd, "check-ignore", ".serena/project.yml", ".another-tool/state");
      expect(result.stdout).toBe(".serena/project.yml\n.another-tool/state\n");
    }
    expect((await git(checkout, "config", "--global", "--get", "core.excludesFile")).stdout.trim()).toBe("~/git ignore");
    await expect(execute(process.execPath, [helper, ".x\n!tracked"], { cwd: checkout, env })).rejects.toThrow(/one Git ignore pattern/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
