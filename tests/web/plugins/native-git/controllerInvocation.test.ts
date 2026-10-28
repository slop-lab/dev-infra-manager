import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { webPlugin } from "../../../../packages/web/plugins/native-git/src/index.js";
import { describeNativeProjectConsole, invokeNativeProjectConsole } from "../../../../packages/host/plugins/native-git/src/projectConsole.js";
import { managedProjectFixture } from "../../../host/plugins/native-git/nativeProjectIntegrationFixture.js";
import { cleanupFinalizeFixtures, generationId, humanReviewer } from "../../../control-plane/plugins/git-repositories/nativeRootImportFinalizeFixture.js";

const roots: string[] = [];
afterEach(async () => {
  await cleanupFinalizeFixtures();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it("avoids repeated controller descriptions while the host still rejects revoked current reviewer authority", async () => {
  const fixture = await managedProjectFixture();
  roots.push(fixture.root);
  await fixture.importRepository("public");
  const reviewer = join(fixture.root, "reviewer.json");
  await writeFile(reviewer, JSON.stringify({ schemaVersion: 1, serviceId: "native-main",
    baseUrl: fixture.service.origin, generationId, ...humanReviewer }), { mode: 0o600 });
  const environment = { ...process.env, DIM_MANAGED_STATE_ROOT: fixture.state,
    DIM_NATIVE_CONTROL_PLANE_CONNECTION_FILE: fixture.hostFile };
  let descriptions = 0;
  const runtime = await webPlugin.autoConnect?.({ controllers: [{ id: "host-a", async run(args) {
    const generationIndex = args.indexOf("--expected-generation");
    const expectedGeneration = generationIndex < 0 ? undefined : args[generationIndex + 1];
    if (args[2] === "describe") {
      descriptions += 1;
      return describeNativeProjectConsole(environment, expectedGeneration);
    }
    const name = args[3], input = args[args.indexOf("--input") + 1];
    if (name === undefined || input === undefined || expectedGeneration === undefined) {
      throw new Error("invalid fixture invocation");
    }
    const value: unknown = JSON.parse(input);
    return invokeNativeProjectConsole(name, value, expectedGeneration, environment);
  } }] });
  if (runtime === undefined) throw new Error("automatic connection is unavailable");
  const input = { controllerId: "host-a", projectId: "project-a", repositoryId: "public" };
  await runtime.invoke("projects.list", {});
  expect(await runtime.invoke("reviews.list", input)).toEqual([]);
  expect(await runtime.invoke("reviews.list", input)).toEqual([]);
  expect(descriptions).toBe(1);

  const original: unknown = JSON.parse(await readFile(reviewer, "utf8"));
  if (typeof original !== "object" || original === null) throw new Error("invalid fixture reviewer");
  await writeFile(reviewer, JSON.stringify({ ...original, password: "revoked-fixture-credential" }));
  await expect(runtime.invoke("reviews.list", input)).rejects.toMatchObject({ status: 401 });
  expect(descriptions).toBe(1);
});
