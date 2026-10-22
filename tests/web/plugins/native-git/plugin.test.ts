import { createServer } from "node:http";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { webPlugin, operations } from "../../../../packages/web/plugins/native-git/src/index.js";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture(options: { promoter?: boolean; sync?: boolean; stale?: boolean; wrongRole?: boolean; wrongReviewer?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), "dim-native-web-plugin-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const generationId = "a".repeat(64), calls: string[] = [];
  const server = createServer((req, res) => {
    calls.push(`${req.method} ${req.url}`);
    res.setHeader("Content-Type", "application/json"); res.setHeader("Cache-Control", "no-store");
    if (req.url === "/v1/human-reviewer-identity") return res.end(JSON.stringify({ schemaVersion: 1, serviceId: "native-main", role: options.wrongRole ? "host-promoter" : "human-reviewer", reviewerId: options.wrongReviewer ? "foreign" : "owner", generationId }));
    if (req.url === "/v1/host-promoter-identity") return res.end(JSON.stringify({ schemaVersion: 1, serviceId: "native-main", role: "host-promoter", hostId: "devbox", generationId }));
    if (req.url === "/v1/git-sync-operator-identity") return res.end(JSON.stringify({ schemaVersion: 1, serviceId: "native-main", role: "git-sync-operator", hostId: "devbox", generationId }));
    if (req.url?.endsWith("/reviews")) return res.end("[]");
    if (req.url?.endsWith("/sync/publish")) {
      expect(req.headers.authorization).toBe(`Basic ${Buffer.from(`sync:${"s".repeat(43)}`).toString("base64")}`);
      expect(req.headers["x-dim-generation-id"]).toBe(generationId);
      return res.end(JSON.stringify({ schemaVersion: 1, outcome: "published", sourceCommit: "b".repeat(40), targetRef: "refs/heads/development" }));
    }
    res.statusCode = 404; res.end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("missing fixture address");
  const baseUrl = `http://127.0.0.1:${address.port}`, reviewerConnection = join(root, "reviewer.json"), promoterConnection = join(root, "promoter.json"), syncConnection = join(root, "sync.json");
  await writeFile(reviewerConnection, JSON.stringify({ schemaVersion: 1, serviceId: "native-main", baseUrl, generationId: options.stale ? "c".repeat(64) : generationId, reviewerId: "owner", username: "reviewer", password: "p".repeat(43) }), { mode: 0o600 });
  await writeFile(promoterConnection, JSON.stringify({ schemaVersion: 1, serviceId: "native-main", endpoint: baseUrl, generationId, role: "host-promoter", hostId: "devbox", credential: { username: "promoter", password: "p".repeat(43) } }), { mode: 0o600 });
  await writeFile(syncConnection, JSON.stringify({ schemaVersion: 1, serviceId: "native-main", endpoint: baseUrl, generationId, role: "git-sync-operator", hostId: "devbox", credential: { username: "sync", password: "s".repeat(43) } }), { mode: 0o600 });
  return { calls, reviewerConnection, config: { reviewerConnection, projects: [{ projectId: "project-a", repositoryIds: ["public", "private"] }], ...(options.promoter ? { promoterConnection } : {}), ...(options.sync ? { syncConnection } : {}) } };
}
it("attests configured reviewer, exposes scoped repositories and omits unconfigured authority", async () => {
  const selected = await fixture(); const runtime = await webPlugin.create(selected.config);
  expect(await runtime.invoke("projects.list", {})).toMatchObject({ controllers: [{ id: "direct", reviewerId: "owner", projects: [{ projectId: "project-a", repositoryIds: ["public", "private"] }] }] });
  expect(await runtime.invoke("projects.list", {})).not.toMatchObject({ controllers: [{ controllerKey: expect.anything() }] });
  expect(await runtime.invoke("reviews.list", { controllerId: "direct", projectId: "project-a", repositoryId: "public" })).toEqual([]);
  expect(runtime.operations?.map((operation) => operation.name)).not.toContain("reviews.promote");
  expect(runtime.operations?.map((operation) => operation.name)).not.toContain("projects.create");
  expect(runtime.operations?.map((operation) => operation.name)).not.toContain("repositories.import");
  expect(runtime.operations?.some((operation) => operation.name.startsWith("sync."))).toBe(false);
  await expect(runtime.invoke("reviews.list", { controllerId: "direct", projectId: "project-a", repositoryId: "foreign" })).rejects.toThrow(/scope|catalog/);
  expect(selected.calls).toEqual(["GET /v1/human-reviewer-identity", "GET /v1/projects/project-a/repositories/public/reviews"]);
});
it("rejects a stale serving identity and public connection files before enabling review", async () => {
  const stale = await fixture({ stale: true }); await expect(webPlugin.create(stale.config)).rejects.toThrow("identity");
  const publicFile = await fixture(); await chmod(publicFile.reviewerConnection, 0o644);
  await expect(webPlugin.create(publicFile.config)).rejects.toThrow("private connection");
});
it("attests optional authorities and publishes only through scoped exact operator endpoint", async () => {
  const selected = await fixture({ promoter: true, sync: true }), runtime = await webPlugin.create(selected.config);
  expect(runtime.operations?.map((operation) => operation.name)).toContain("reviews.promote");
  expect(await runtime.invoke("sync.publish", { controllerId: "direct", projectId: "project-a", repositoryId: "private" })).toMatchObject({ outcome: "published", targetRef: "refs/heads/development" });
  expect(selected.calls).toContain("POST /v1/projects/project-a/repositories/private/sync/publish");
  await expect(runtime.invoke("sync.publish", { controllerId: "direct", projectId: "project-a", repositoryId: "foreign" })).rejects.toThrow(/scope|catalog/);
});
it("rejects browser-supplied service paths and strips non-public review evidence", () => {
  const listing = operations.find((operation) => operation.name === "reviews.list")!;
  expect(() => listing.parseInput({ controllerId: "direct", repositoryId: "public", projectId: "project-a", endpoint: "https://foreign.test" })).toThrow();
  expect(() => listing.parseInput({ repositoryId: "../private" })).toThrow();
  expect(() => listing.parseOutput([{ reviewId: "a".repeat(64), proposalRef: "refs/proposal/a", protectedRef: "refs/heads/main", candidateCommit: "b".repeat(40), createdAt: new Date().toISOString(), status: "approved", password: "secret" }])).toThrow();
});

it("rejects wrong serving role and reviewer identities before loading browser review operations", async () => {
  for (const options of [{ wrongRole: true }, { wrongReviewer: true }]) {
    const selected = await fixture(options);
    await expect(webPlugin.create(selected.config)).rejects.toThrow();
    expect(selected.calls).toEqual(["GET /v1/human-reviewer-identity"]);
  }
});

it("discovers controller projects independently and refreshes their live repository catalog", async () => {
  const calls: Array<{ controller: string; args: readonly string[] }> = [];
  let repositories = ["public", "private"];
  const descriptors = operations.filter(({ name }) => name === "projects.list" || name === "reviews.list").map(({ name, description, access }) => ({ name, description, access }));
  const runtime = await webPlugin.autoConnect!({ controllers: [
    { id: "offline", async run() { throw new Error("unavailable"); } },
    { id: "devbox", async run(args) {
      calls.push({ controller: "devbox", args });
      if (args.slice(0, 3).join(" ") === "project console describe") return { schemaVersion: 1, generationId: "a".repeat(64), reviewerId: "owner",
        projects: [{ projectId: "project-a", name: "Project A", repositoryIds: repositories }, { projectId: "project-b", name: "Project B", repositoryIds: ["public"] }], operations: descriptors };
      return [];
    } }
  ] });
  expect(await runtime.invoke("projects.list", {})).toMatchObject({ controllers: [
    { id: "offline", controllerKey: "offline", status: "unavailable", projects: [] },
    { id: "devbox", controllerKey: "devbox", status: "ready", projects: [{ projectId: "project-a", repositoryIds: ["public", "private"] }, { projectId: "project-b" }] }
  ] });
  expect(await runtime.invoke("reviews.list", { controllerId: "devbox", projectId: "project-b", repositoryId: "public" })).toEqual([]);
  expect(calls.at(-1)?.args).toEqual(["project", "console", "invoke", "reviews.list", "--expected-generation", "a".repeat(64), "--input", JSON.stringify({ projectId: "project-b", repositoryId: "public" })]);
  const before = calls.length;
  await expect(runtime.invoke("reviews.list", { controllerId: "offline", projectId: "project-a", repositoryId: "public" })).rejects.toThrow("unavailable");
  await expect(runtime.invoke("reviews.list", { controllerId: "devbox", projectId: "project-b", repositoryId: "private" })).rejects.toThrow("scope");
  await expect(runtime.invoke("reviews.list", { controllerId: "devbox", projectId: "foreign", repositoryId: "public" })).rejects.toThrow("scope");
  expect(calls).toHaveLength(before);
  repositories = ["public", "private", "docs"];
  await runtime.invoke("projects.list", {});
  expect(await runtime.invoke("reviews.list", { controllerId: "devbox", projectId: "project-a", repositoryId: "docs" })).toEqual([]);
});
it("rejects the old single-project contract and browser connection or controller injection", async () => {
  const selected = await fixture();
  await expect(webPlugin.create({ reviewerConnection: selected.reviewerConnection, projectId: "project-a", repositoryIds: ["public"] })).rejects.toThrow();
  const runtime = await webPlugin.create(selected.config);
  await expect(runtime.invoke("reviews.list", { controllerId: "foreign", projectId: "project-a", repositoryId: "public" })).rejects.toThrow("scope");
  const listing = operations.find(({ name }) => name === "reviews.list")!;
  expect(() => listing.parseInput({ controllerId: "direct", projectId: "project-a", repositoryId: "public", executable: "/host/shell" })).toThrow();
  expect(listing.parseInput({ controllerId: "direct", projectId: "project-a", repositoryId: "public" })).toEqual({ controllerId: "direct", projectId: "project-a", repositoryId: "public" });
});

it("pins controller discovery generation across refresh and sends it before delegated actions", async () => {
  let generationId = "a".repeat(64); const writes: string[][] = [];
  const context = { controllers: [{ id: "devbox", async run(args: readonly string[]) {
    if (args[2] === "describe") return { schemaVersion: 1, generationId, reviewerId: "owner", projects: [{ projectId: "project-a", name: "Project A", repositoryIds: ["public"] }],
      operations: operations.filter(({ name }) => name === "projects.list" || name === "reviews.list").map(({ name, description, access }) => ({ name, description, access })) };
    writes.push([...args]); return [];
  } }] };
  const runtime = await webPlugin.autoConnect!(context);
  await runtime.invoke("reviews.list", { controllerId: "devbox", projectId: "project-a", repositoryId: "public" });
  expect(writes[0]).toContain("--expected-generation"); expect(writes[0]).toContain(generationId);
  generationId = "b".repeat(64);
  expect(await runtime.invoke("projects.list", {})).toMatchObject({ controllers: [{ id: "devbox", status: "unavailable" }] });
  await expect(runtime.invoke("reviews.list", { controllerId: "devbox", projectId: "project-a", repositoryId: "public" })).rejects.toThrow("unavailable");
  expect(writes).toHaveLength(1);
  const reconnected = await webPlugin.autoConnect!(context);
  await reconnected.invoke("reviews.list", { controllerId: "devbox", projectId: "project-a", repositoryId: "public" });
  expect(writes[1]).toContain(generationId);
});

it("keeps an empty registered-project catalog available but reports wholly unavailable controllers", async () => {
  const offline = await webPlugin.autoConnect!({ controllers: [{ id: "offline", async run() { throw new Error("host plugin missing"); } }] });
  expect(await offline.invoke("projects.list", {})).toMatchObject({ controllers: [{ id: "offline", controllerKey: "offline", status: "unavailable", projects: [] }] });
  const runtime = await webPlugin.autoConnect!({ controllers: [{ id: "empty", async run() { return { schemaVersion: 1, generationId: "a".repeat(64), reviewerId: "owner", projects: [], operations: [] }; } }] });
  expect(await runtime.invoke("projects.list", {})).toMatchObject({ controllers: [{ id: "empty", status: "ready", projects: [] }] });
});

it("delegates controller-only project creation and public imports with exact scope and import deadline", async () => {
  let projects: Array<{ projectId: string; name: string; repositoryIds: string[] }> = [];
  const calls: Array<{ args: readonly string[]; timeout?: number }> = [];
  const runtime = await webPlugin.autoConnect!({ controllers: [{ id: "devbox", async run(args, options) {
    if (args[2] === "describe") return { schemaVersion: 1, generationId: "a".repeat(64), reviewerId: "owner", projects,
      operations: operations.map(({ name, description, access }) => ({ name, description, access })) };
    calls.push({ args, ...(options ? { timeout: options.timeoutMilliseconds } : {}) });
    const input = JSON.parse(args[args.indexOf("--input") + 1]!) as { projectId: string; repositoryId?: string };
    if (args[3] === "projects.create") { const project = { projectId: input.projectId, name: input.projectId, repositoryIds: [] }; projects.push(project); return project; }
    const project = projects.find(({ projectId }) => projectId === input.projectId)!; project.repositoryIds.push(input.repositoryId!);
    return { projectId: input.projectId, repositoryId: input.repositoryId!, protectedRef: "refs/heads/main", commit: "b".repeat(40), tree: "c".repeat(40), projectReady: true };
  } }] });
  expect(await runtime.invoke("projects.create", { controllerId: "devbox", projectId: "new-project" })).toMatchObject({ projectId: "new-project" });
  await runtime.invoke("projects.list", {});
  const imported = await runtime.invoke("repositories.import", { controllerId: "devbox", projectId: "new-project", repositoryId: "public", url: "https://github.com/example/public.git" });
  expect(imported).toMatchObject({ repositoryId: "public", projectReady: true }); expect(calls.at(-1)?.timeout).toBe(180_000);
  await runtime.invoke("projects.list", {});
  const count = calls.length;
  await expect(runtime.invoke("projects.create", { controllerId: "devbox", projectId: "new-project" })).rejects.toThrow("already exists");
  await expect(runtime.invoke("repositories.import", { controllerId: "devbox", projectId: "foreign", repositoryId: "public", url: "https://github.com/example/public.git" })).rejects.toThrow("scope");
  await expect(runtime.invoke("repositories.import", { controllerId: "devbox", projectId: "new-project", repositoryId: "public", url: "https://github.com/example/public.git" })).rejects.toThrow("already exists");
  expect(calls).toHaveLength(count);
  const create = operations.find(({ name }) => name === "projects.create")!, importing = operations.find(({ name }) => name === "repositories.import")!;
  expect(create.access).toBe("operator"); expect(importing.access).toBe("operator");
  expect(() => create.parseInput({ controllerId: "devbox", projectId: "injected", path: "/host/project" })).toThrow();
  expect(() => importing.parseInput({ controllerId: "devbox", projectId: "new-project", repositoryId: "extra", url: "https://github.com/example/public.git", policy: { allow: "all" } })).toThrow();
  for (const url of ["http://github.com/example/a.git", "https://user:secret@github.com/example/a.git", "file:///host/secret"]) expect(() => importing.parseInput({ controllerId: "devbox", projectId: "new-project", repositoryId: "private", url })).toThrow();
});

it("keeps manifest preview/import controller-scoped and gives imports their bounded deadline", async () => {
  const calls: Array<{ args: readonly string[]; timeout?: number }> = [];
  const policy = { "code-review": { requiredReviewerIds: ["owner"] } };
  const preview = { projectId: "project-a", repositories: [{ repositoryId: "root", url: "https://github.com/example/root.git", branch: "main", protectedRef: "refs/heads/main", defaultRef: "refs/heads/main", branches: { "refs/heads/main": { review: true }, "refs/heads/development": { review: false } }, policy }], configurationRepositoryId: "root", defaultWorkingRepositoryId: "root" };
  const runtime = await webPlugin.autoConnect!({ controllers: [{ id: "devbox", async run(args, options) {
    if (args[2] === "describe") return { schemaVersion: 1, generationId: "a".repeat(64), reviewerId: "owner", projects: [{ projectId: "project-a", name: "project-a", repositoryIds: [] }], operations: operations.map(({ name, description, access }) => ({ name, description, access })) };
    calls.push({ args, ...(options ? { timeout: options.timeoutMilliseconds } : {}) });
    return args[3] === "repositories.preview-manifest" ? preview : { projectId: "project-a", repositories: [{ projectId: "project-a", repositoryId: "root", protectedRef: "refs/heads/main", commit: "b".repeat(40), tree: "c".repeat(40), projectReady: true }] };
  } }] });
  const input = { controllerId: "devbox", projectId: "project-a", manifest: "schemaVersion: 1\nrepositories: {}\n" };
  expect(await runtime.invoke("repositories.preview-manifest", input)).toEqual(preview);
  expect(calls.at(-1)?.timeout).toBeUndefined();
  expect(await runtime.invoke("repositories.import-manifest", input)).toMatchObject({ projectId: "project-a", repositories: [{ repositoryId: "root" }] });
  expect(calls.at(-1)?.timeout).toBe(180_000);
  const count = calls.length;
  await expect(runtime.invoke("repositories.import-manifest", { ...input, projectId: "foreign" })).rejects.toThrow("scope");
  expect(calls).toHaveLength(count);
  for (const name of ["repositories.preview-manifest", "repositories.import-manifest"]) {
    const operation = operations.find((operation) => operation.name === name)!;
    expect(operation.access).toBe("operator");
    expect(() => operation.parseInput({ ...input, path: "/host/.dim/repos.yml" })).toThrow();
  }
});
