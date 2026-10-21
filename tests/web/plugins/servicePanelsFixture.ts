import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";
import { createWebServerFromConfigFile } from "../../../packages/web/core/src/server.js";
import { initializeOperationsWeb } from "../../../packages/web/core/src/initialize.js";
import { parseWebConfig } from "../../../packages/web/core/src/config.js";
import { configuredExecutionServer } from "../../../packages/control-plane/plugins/execution-scheduler/src/service.js";
import { executionServiceConfigSchema } from "../../../packages/control-plane/plugins/execution-scheduler/src/config.js";
import { idleExecutionConfig } from "../../control-plane/plugins/git-repositories/bundleConfigFixture.js";
import { nativeBundleReviewFixture, createBundleReview, reviewProposalRef } from "../../control-plane/plugins/git-ci/nativeBundleReviewFixture.js";
import { humanReviewer, generationId } from "../../control-plane/plugins/git-repositories/nativeRootImportFinalizeFixture.js";
import { event, generation, grant, slot, result, hash } from "../../contracts/ci/executionFixture.js";

export async function createServicePanelsFixture() {
  const root = await mkdtemp(join(tmpdir(), "dim-service-panels-"));
  const native = await nativeBundleReviewFixture("service-panels");
  const envelope = await createBundleReview(native.service);
  const config = executionServiceConfigSchema.parse(idleExecutionConfig());
  const ci = configuredExecutionServer({ config, stateDirectory: join(root, "ci-state"), readinessToken: "ready", activationToken: "activate", expectedGenerationId: generation,
    source: { authorize: async (job) => grant(job), candidate: async () => { throw new Error("unused"); }, publish: async () => {} } });
  try {
    await new Promise<void>((resolve) => ci.server.listen(0, "127.0.0.1", resolve));
    const address = ci.server.address(); if (!address || typeof address === "string") throw new Error("missing CI listener");
    const endpoint = `http://127.0.0.1:${address.port}`;
    const activation = await fetch(endpoint + "/v1/activation", { method: "POST", headers: { authorization: "Bearer activate", "content-type": "application/json" }, body: JSON.stringify({ schemaVersion: 1, generationId: generation }) });
    if (activation.status !== 200) throw new Error("activation failed");
    ci.store.enqueue(event("completed"));
    const assignment = ci.store.reserve("host-a", slot, randomUUID())!;
    const authorized = ci.store.attachGrant(assignment.id, grant(assignment)), evidence = result(authorized.grant!);
    const output = Buffer.from("browser-safe-diagnostic\n");
    evidence.stdout = { bytes: String(output.length), sha256: `sha256:${hash(output.toString())}`, truncated: false };
    evidence.logs.stdout.base64 = output.toString("base64");
    ci.store.finish(authorized.id, "host-a", slot.id, authorized.leaseToken, evidence);
    const queued = ci.store.enqueue(event("queued"));
    for (const role of ["query", "operator"] as const) await writeFile(join(root, role === "query" ? "ci-query.json" : "execution-operator.json"), JSON.stringify({ schemaVersion: 1, role, endpoint, generationId: generation, credential: config.credentials[role] }), { mode: 0o600 });
    const reviewerConnection = join(root, "reviewer.json");
    await writeFile(reviewerConnection, JSON.stringify({ schemaVersion: 1, serviceId: "native-main", baseUrl: native.service.origin, generationId, ...humanReviewer }), { mode: 0o600 });
    const settings = join(root, "operations.json"), file = join(root, "web.json");
    await writeFile(settings, JSON.stringify({ hosts: [] }), { mode: 0o600 });
    const portServer = createServer(); await new Promise<void>((resolve) => portServer.listen(0, "127.0.0.1", resolve));
    const portAddress = portServer.address(); if (!portAddress || typeof portAddress === "string") throw new Error("port missing");
    await new Promise<void>((resolve) => portServer.close(() => resolve()));
    const browser = await initializeOperationsWeb({ operations: settings, output: file, port: portAddress.port });
    const generated = parseWebConfig(JSON.parse(await readFile(file, "utf8")));
    const operatorAccount = generated.accounts[0]; if (!operatorAccount) throw new Error("generated operator missing");
    const combined = { ...generated, pluginHome: fileURLToPath(new URL("../../", import.meta.url)),
      accounts: [{ ...operatorAccount, roles: ["read", "operator", "reviewer"] }, { ...operatorAccount, username: "readonly", roles: ["read"] }],
      plugins: [
        { package: "@slop-lab/dim-web-plugin-execution", config: { queryConnection: join(root, "ci-query.json"), operatorConnection: join(root, "execution-operator.json") } },
        { package: "@slop-lab/dim-web-plugin-native-git", config: { reviewerConnection, projectId: "project-a", repositoryIds: ["root"] } }
      ] };
    await writeFile(file, JSON.stringify(combined), { mode: 0o600 });
    const web = await createWebServerFromConfigFile(file);
    return { origin: await web.listen(), username: browser.username, password: browser.password,
      queuedId: queued.id, completedId: authorized.id, reviewId: envelope.review.reviewId, proposalRef: reviewProposalRef,
      execution: () => ci.store.get(queued.id),
      async close() { await web.close(); await ci.close(); await native.service.close(); await Promise.all([root, native.root, native.clone].map((path) => rm(path, { recursive: true, force: true }))); }
    };
  } catch (error) { await ci.close(); await native.service.close(); await Promise.all([root, native.root, native.clone].map((path) => rm(path, { recursive: true, force: true }))); throw error; }
}
