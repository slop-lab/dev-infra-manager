import { rm } from "node:fs/promises";
import { expect, it } from "vitest";
import { configuredNativeGitBundleServer } from "@slop-lab/dim-control-plane-plugin-git-repositories";
import { repositoryExtension } from "@slop-lab/dim-control-plane-plugin-git-repositories/extensions";
import { fixture } from "./optionalFeaturesFixture.js";

it("closes every extension in reverse order and releases the actual listener and storage owner despite a feature failure", async () => {
  const events: string[] = [];
  const extensions = ["first", "second", "third"].map((name) => repositoryExtension({ name, async attach() { return { async close() { events.push(name); if (name === "second") throw new Error("feature close failed"); } }; } }));
  const f = await fixture(false, extensions);
  let restarted: Awaited<ReturnType<typeof configuredNativeGitBundleServer>> | undefined;
  try {
    await expect(f.service.close()).rejects.toThrow(/repository shutdown failed/);
    expect(events).toEqual(["third", "second", "first"]);
    expect(f.service.server.listening).toBe(false);
    restarted = await configuredNativeGitBundleServer({ ...f.options, extensions: [] });
    expect(restarted.context.runtime.state.stateFormat).toBe(10);
  } finally { await restarted?.close(); await f.service.close().catch(() => undefined); await rm(f.root, { recursive: true, force: true }); }
}, 20_000);

it("cleans already attached features and storage after a later attach failure, preserving both errors", async () => {
  const f = await fixture(false);
  let restarted: Awaited<ReturnType<typeof configuredNativeGitBundleServer>> | undefined;
  try {
    await f.service.close();
    const events: string[] = [];
    const options = { ...f.options, extensions: [
      repositoryExtension({ name: "first", async attach() { return { async close() { events.push("first-closed"); throw new Error("cleanup failed"); } }; } }),
      repositoryExtension({ name: "second", async attach() { throw new Error("attach failed"); } })
    ] };
    const error: unknown = await configuredNativeGitBundleServer(options).catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(AggregateError);
    if (!(error instanceof AggregateError)) throw new Error("startup failure was not aggregated");
    expect(error.errors.map((entry: unknown) => entry instanceof Error ? entry.message : String(entry))).toEqual(["attach failed", "repository extension cleanup failed"]);
    expect(events).toEqual(["first-closed"]);
    restarted = await configuredNativeGitBundleServer(f.options);
    expect(restarted.context.available()).toBe(true);
  } finally { await restarted?.close(); await f.service.close(); await rm(f.root, { recursive: true, force: true }); }
}, 20_000);

it("restarts review hosting with a prepared repository whose source has not been imported", async () => {
  const f = await fixture(true);
  let restarted: Awaited<ReturnType<typeof configuredNativeGitBundleServer>> | undefined;
  try {
    await f.service.prepareProject(f.service.context.runtime.expectedGenerationId, "host-a", { serviceId: "native-main", projectId: "project", repositoryId: "pending" });
    await f.service.close();
    restarted = await configuredNativeGitBundleServer(f.options);
    expect(restarted.context.runtime.activated()).toBe(true);
    expect(restarted.context.available()).toBe(true);
  } finally { await restarted?.close(); await f.service.close(); await rm(f.root, { recursive: true, force: true }); }
}, 20_000);
