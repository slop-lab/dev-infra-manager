import { execFile } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { serveGitBackend } from "../../packages/control-plane/plugins/git-repositories/src/backend.js";
import { nativeGitRoute } from "../../packages/control-plane/plugins/git-repositories/src/routing.js";

const run = promisify(execFile);
const gitExecutable = "/usr/bin/git";
export type GitObjectFormat = "sha1" | "sha256";
export type GitHttpFixture = {
  readonly root: string;
  readonly baseUrl: string;
  readonly config: { readonly gitExecutable: string };
  repositoryPath(projectId: string, repositoryId: string): string;
  url(projectId: string, repositoryId: string): string;
  git(cwd: string, args: readonly string[]): Promise<{ readonly stdout: string; readonly stderr: string }>;
  close(): Promise<void>;
};

/** Smart-HTTP transport for Git client safety tests. Service authority is tested against installed bundles. */
export async function gitHttpFixture(objectFormat: GitObjectFormat = "sha1"): Promise<GitHttpFixture> {
  const root = await mkdtemp(join(tmpdir(), "dim-git-http-"));
  const storageRoot = join(root, "storage");
  for (const projectId of ["project-a", "project-b"]) {
    const bare = join(storageRoot, projectId, "source.git");
    const source = join(root, `${projectId}-source`);
    await mkdir(join(storageRoot, projectId), { recursive: true, mode: 0o700 });
    await run(gitExecutable, ["init", "--bare", "--shared=0600", "--initial-branch=main", `--object-format=${objectFormat}`, bare]);
    await run(gitExecutable, ["init", "--initial-branch=main", `--object-format=${objectFormat}`, source]);
    await run(gitExecutable, ["-C", source, "config", "user.name", "DIM Git fixture"]);
    await run(gitExecutable, ["-C", source, "config", "user.email", "fixture@example.invalid"]);
    await writeFile(join(source, "README.md"), `${projectId}-initial\n`);
    await run(gitExecutable, ["-C", source, "add", "."]);
    await run(gitExecutable, ["-C", source, "commit", "-m", "initial"]);
    await run(gitExecutable, ["--git-dir", bare, "fetch", source, "refs/heads/main:refs/heads/main"]);
    await run(gitExecutable, ["--git-dir", bare, "config", "http.receivepack", "true"]);
  }
  const backendFailures: unknown[] = [];
  const server = createServer((request, response) => {
    const route = nativeGitRoute(request);
    if (route === undefined) { response.writeHead(404).end(); return; }
    void serveGitBackend({ config: { gitExecutable, storageRoot }, protectedRefs: ["refs/heads/main", "refs/heads/development"],
      identity: route.operation === "write"
        ? { role: "writer", username: "test-transport", workspaceId: "workspace-a" }
        : { role: "reader", username: "test-transport" }, route, request, response }).catch((error: unknown) => {
      backendFailures.push(error);
      if (!response.headersSent) response.writeHead(503).end(); else response.destroy();
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("expected TCP listener");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  return { root, baseUrl, config: { gitExecutable },
    repositoryPath: (projectId, repositoryId) => join(storageRoot, projectId, `${repositoryId}.git`),
    url: (projectId, repositoryId) =>
      `${baseUrl}/v1/projects/${projectId}/repositories/${repositoryId}.git`,
    git: (cwd, args) => run(gitExecutable, [...args], { cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" } }),
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      await rm(root, { recursive: true, force: true });
      if (backendFailures.length) throw new AggregateError(backendFailures, "Git HTTP fixture backend failed");
    }
  };
}
