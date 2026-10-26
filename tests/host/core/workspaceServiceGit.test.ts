import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { ProcessRunner } from "../../../packages/host/core/src/runner.js";
import { openWorkspaceServiceChannel } from "../../../packages/host/core/src/workspace/serviceChannel.js";
import { publicGitFixture } from "../plugins/native-git/publicGitFixture.js";

it("clones, fetches and pushes an actual Git commit through the shared stdio channel", async () => {
  const fx = await publicGitFixture(), runner = new ProcessRunner();
  const channel = openWorkspaceServiceChannel({ token: randomBytes(32).toString("base64url"), port: 0, signal: new AbortController().signal,
    current: async () => true, resolve: async (name) => name === "git" ? fx.endpoint : undefined,
    exec: (command, options) => runner.runStreaming(command[0] ?? "node", command.slice(1), options),
  });
  try {
    await fx.git(["-C", join(fx.root, "upstream.git"), "config", "http.receivepack", "true"]);
    const port = await channel.ready, checkout = join(fx.root, "guest-checkout");
    await fx.git(["clone", `http://127.0.0.1:${port}/services/git/upstream.git`, checkout]);
    expect((await fx.git(["-C", checkout, "rev-parse", "HEAD"])).stdout.trim()).toBe(fx.commit);
    await fx.git(["-C", checkout, "config", "user.name", "Disposable guest"]);
    await fx.git(["-C", checkout, "config", "user.email", "guest@example.invalid"]);
    await fx.git(["-C", checkout, "checkout", "-b", "fixture/write"]);
    await writeFile(join(checkout, "write.txt"), "actual guest transport write\n");
    await fx.git(["-C", checkout, "add", "write.txt"]);
    await fx.git(["-C", checkout, "commit", "-m", "scoped transport write"]);
    await fx.git(["-C", checkout, "push", "origin", "HEAD:refs/heads/fixture/write"]);
    const commit = (await fx.git(["-C", checkout, "rev-parse", "HEAD"])).stdout.trim();
    expect((await fx.git(["--git-dir", join(fx.root, "upstream.git"), "rev-parse", "refs/heads/fixture/write"])).stdout.trim()).toBe(commit);
    await fx.git(["-C", checkout, "fetch", "origin"]);
    expect(fx.paths.some((path) => path.endsWith("/git-receive-pack"))).toBe(true);
    expect(fx.paths.some((path) => path.endsWith("/git-upload-pack"))).toBe(true);
  } finally { await channel.close(); await fx.close(); }
});
