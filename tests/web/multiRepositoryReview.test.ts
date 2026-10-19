import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { nativeBundleReviewFixture, createBundleReview } from "../control-plane/plugins/native-git/nativeBundleReviewFixture.js";
import { authoritativePolicy } from "../control-plane/plugins/native-git/authoritativeNativeCandidateFixture.js";
import { cleanupFinalizeFixtures, createRootBundle, uploadRootBundle, parseImportReceipt, finalizeRootImport,
  generationId, importer, projectInput } from "../control-plane/plugins/native-git/nativeRootImportFinalizeFixture.js";
import { createReviewerWebServerFromConfigFile } from "../../packages/web/src/server.js";
import { parseReviewerWebConfig } from "../../packages/web/src/config.js";
import { availablePort, WEB_PASSWORD, webConfig } from "./webHarness.js";

afterEach(cleanupFinalizeFixtures);
it("selects independent repositories in one web Project and fences review IDs by repository", async () => {
  const native = await nativeBundleReviewFixture("web-multi", undefined, authoritativePolicy(["owner"], [], [], ["public"]),
    undefined, undefined, undefined, undefined, {}, undefined, "jobs: {}\n", undefined, "public");
  await native.service.prepareProject(generationId, importer.hostId, projectInput("project-a", "private"));
  const bundle = await createRootBundle({ "README.md": "private bytes\n" });
  const receipt = parseImportReceipt(await (await uploadRootBundle(native.service.origin, bundle,
    authoritativePolicy(["owner"], [], [], ["private"]), "private")).json());
  expect((await finalizeRootImport(native.service.origin, { schemaVersion: 1, generationId,
    importNonce: receipt.importNonce, bundleDigest: receipt.bundleDigest }, undefined, "private")).status).toBe(200);
  const envelope = await createBundleReview(native.service, "public");
  const root = await mkdtemp(join(tmpdir(), "dim-web-multi-")), port = await availablePort();
  const origin = `http://127.0.0.1:${port}`;
  const config = parseReviewerWebConfig(webConfig({ accounts: ["owner"], reviewerAccountId: "owner", nativeBaseUrl: native.service.origin, publicOrigin: origin, port }));
  const file = join(root, "web.json");
  await writeFile(file, JSON.stringify({ ...config, nativeGit: { ...config.nativeGit, repositoryIds: ["public", "private"] } }), { mode: 0o600 });
  const web = await createReviewerWebServerFromConfigFile(file);
  try {
    await web.listen();
    const login = await fetch(origin + "/v1/session", { method: "POST", headers: { origin, "content-type": "application/json" },
      body: JSON.stringify({ username: "owner", password: WEB_PASSWORD }) });
    expect(login.status).toBe(201);
    expect(await login.json()).toMatchObject({ repositoryIds: ["public", "private"] });
    const headers = { cookie: login.headers.get("set-cookie")!.split(";")[0]! };
    const reviews = "/v1/projects/project-a/repositories/";
    expect((await fetch(origin + reviews + "public/reviews", { headers })).status).toBe(200);
    expect(await (await fetch(origin + reviews + "private/reviews", { headers })).json()).toEqual([]);
    const read = await fetch(origin + reviews + `public/reviews/${envelope.review.reviewId}`, { headers });
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({ repositoryId: "public", inputs: envelope.review.inputs });
    expect((await fetch(origin + reviews + `private/reviews/${envelope.review.reviewId}`, { headers })).status).toBe(404);
    expect((await fetch(origin + reviews + "unconfigured/reviews", { headers })).status).toBe(404);
  } finally { await web.close(); await rm(root, { recursive: true, force: true }); }
});
