import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { collectControlPlaneClaims } from "../../../scripts/local-uninstall/control-plane.ts";

function record(prefix = "execution") {
  return { schemaVersion: 1, deploymentId: "dim", generationId: "a".repeat(64), composeSha256: `sha256:${"b".repeat(64)}`,
    nativeGitImage: `example/native@sha256:${"c".repeat(64)}`, [`${prefix}Image`]: `example/execution@sha256:${"d".repeat(64)}`,
    nativeGitPublish: { host: "127.0.0.1", port: 8787 }, [`${prefix}Publish`]: { host: "127.0.0.1", port: 8788 },
    ...Object.fromEntries(["nativeGitConfig", "nativeGitReadinessToken", "nativeGitActivationToken", `${prefix}Config`, `${prefix}ReadinessToken`, `${prefix}ActivationToken`]
      .map((key) => [`${key}Sha256`, `sha256:${"e".repeat(64)}`])), volumesEstablished: true };
}
it.each(["execution", "ordinaryCi"])("requires exact %s ownership before identifying Docker resources", async (prefix) => {
  const root = await mkdtemp(join(tmpdir(), "dim-uninstall-cp-"));
  try {
    await writeFile(join(root, "install.json"), JSON.stringify(record(prefix)));
    const claims = await collectControlPlaneClaims(root);
    const service = prefix === "execution" ? prefix : "ordinary-ci";
    expect(claims).toHaveLength(5);
    expect(claims.find((claim) => claim.name === `dim-control-plane-${service}-1`)?.labels)
      .toMatchObject({ "org.dim.deployment": "dim", "org.dim.service": service, "com.docker.compose.service": service });
    await writeFile(join(root, "install.json"), JSON.stringify({ deploymentId: "dim", [`${prefix}Image`]: "anything" }));
    await expect(collectControlPlaneClaims(root)).rejects.toThrow();
  } finally { await rm(root, { recursive: true, force: true }); }
});
it("refuses a transaction without its installed ownership record", async () => {
  const root = await mkdtemp(join(tmpdir(), "dim-uninstall-cp-"));
  try {
    await writeFile(join(root, "transaction.json"), JSON.stringify({ deploymentId: "dim" }));
    await expect(collectControlPlaneClaims(root)).rejects.toThrow(/lacks an installed ownership record/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
it("retains exact prior service claims during a recognized publishing transaction", async () => {
  const root = await mkdtemp(join(tmpdir(), "dim-uninstall-cp-"));
  try {
    await writeFile(join(root, "install.json"), JSON.stringify(record()));
    const prior = { ...record("ordinaryCi"), generationId: "f".repeat(64) };
    const transaction = { schemaVersion: 1, transactionId: "11111111-1111-4111-8111-111111111111", phase: "publishing",
      candidateGenerationId: "a".repeat(64), stagingDirectory: ".staging-11111111-1111-4111-8111-111111111111",
      prior: { generationId: prior.generationId, installBase64: Buffer.from(JSON.stringify(prior)).toString("base64"),
        composeBase64: Buffer.from("reviewed prior compose").toString("base64") } };
    await writeFile(join(root, "transaction.json"), JSON.stringify(transaction));
    expect((await collectControlPlaneClaims(root)).map((claim) => claim.name)).toContain("dim-control-plane-ordinary-ci-1");
    await writeFile(join(root, "transaction.json"), JSON.stringify({ ...transaction, candidateGenerationId: "b".repeat(64) }));
    await expect(collectControlPlaneClaims(root)).rejects.toThrow(/transaction ownership/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
