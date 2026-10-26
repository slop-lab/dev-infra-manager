import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { expect, it } from "vitest";
import { serveGitBackend } from "../../../../packages/control-plane/plugins/git-repositories/src/backend.js";
import { nativeGitRoute } from "../../../../packages/control-plane/plugins/git-repositories/src/routing.js";
import { ProcessRunner } from "../../../../packages/host/core/src/runner.js";
import { openWorkspaceServiceChannel } from "../../../../packages/host/core/src/workspace/serviceChannel.js";
import { publicGitFixture } from "../../../host/plugins/native-git/publicGitFixture.js";

it("fetches protocol-v2 acknowledgments through the channel after divergent history requires a compressed negotiation", async () => {
  const fx = await publicGitFixture(), runner = new ProcessRunner(), requests: { protocol: string | undefined; encoding: string | undefined }[] = [];
  await mkdir(join(fx.root, "project"));
  const bare = join(fx.root, "project/main.git"), checkout = join(fx.root, "guest");
  await fx.git(["clone", "--bare", fx.source, bare]);
  const server = createServer((request, response) => {
    const route = nativeGitRoute(request);
    if (!route) { response.writeHead(404).end(); return; }
    requests.push({ protocol: typeof request.headers["git-protocol"] === "string" ? request.headers["git-protocol"] : undefined,
      encoding: typeof request.headers["content-encoding"] === "string" ? request.headers["content-encoding"] : undefined });
    void serveGitBackend({ config: { gitExecutable: "/usr/bin/git", storageRoot: fx.root }, route, request, response, identity: { role: "reader", username: "fixture" } });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("listener missing");
  const channel = openWorkspaceServiceChannel({ token: randomBytes(32).toString("base64url"), port: 0, signal: new AbortController().signal,
    current: async () => true, resolve: async (name) => name === "git" ? `http://127.0.0.1:${address.port}` : undefined,
    exec: (command, options) => runner.runStreaming(command[0] ?? "node", command.slice(1), options),
  });
  try {
    const port = await channel.ready;
    await fx.git(["-c", "protocol.version=2", "clone", `http://127.0.0.1:${port}/services/git/v1/projects/project/repositories/main.git`, checkout]);
    await fx.git(["-C", checkout, "config", "user.name", "Fixture"]); await fx.git(["-C", checkout, "config", "user.email", "fixture@example.invalid"]);
    const tree = (await fx.git(["-C", checkout, "rev-parse", "HEAD^{tree}"])).stdout.trim();
    let commit = fx.commit;
    for (let index = 0; index < 96; index++) commit = (await fx.git(["-C", checkout, "commit-tree", tree, "-p", commit, "-m", `private ${index}`])).stdout.trim();
    await fx.git(["-C", checkout, "update-ref", "refs/heads/private", commit]);
    await writeFile(join(fx.source, "new.txt"), "upstream advance\n");
    await fx.git(["-C", fx.source, "add", "new.txt"]); await fx.git(["-C", fx.source, "commit", "-m", "upstream advance"]);
    await fx.git(["-C", fx.source, "push", bare, "HEAD:refs/heads/main"]);
    await fx.git(["-C", checkout, "-c", "protocol.version=2", "-c", "fetch.negotiationAlgorithm=consecutive", "fetch", "--negotiation-tip=refs/heads/private", "origin"]);
    expect(requests.some(({ protocol }) => protocol === "version=2")).toBe(true);
    expect(requests.some(({ encoding }) => encoding === "gzip")).toBe(true);
    expect((await fx.git(["-C", checkout, "rev-parse", "origin/main"])).stdout.trim()).toBe((await fx.git(["-C", fx.source, "rev-parse", "HEAD"])).stdout.trim());
  } finally {
    await channel.close(); server.closeAllConnections(); await new Promise<void>((done) => server.close(() => done())); await fx.close();
  }
}, 30_000);
