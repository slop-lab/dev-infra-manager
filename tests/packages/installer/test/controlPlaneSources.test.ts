import { mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseControlPlaneConfig } from "../../../../core/packages/installer/src/controlPlaneConfig.js";
import {
  completeControlPlaneSourcePreflight,
  readControlPlaneSources
} from "../../../../core/packages/installer/src/controlPlaneSources.js";
import { controlPlaneGenerationId } from "../../../../core/packages/installer/src/controlPlaneGenerationId.js";
import {
  controlPlaneSecrets,
  nativeServiceConfig,
  ordinaryServiceConfig,
  writeControlPlaneFixture,
  writePrivate
} from "./controlPlaneFixture.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "dim-control-plane-sources-"));
  temporaryDirectories.push(directory);
  const value = await writeControlPlaneFixture(directory);
  return { ...value, parsed: parseControlPlaneConfig(value.config, ["127.0.0.1"]) };
}

describe("control-plane private source staging", () => {
  it.each(["grantIssuer", "candidateReader", "resultReporter", "webhook"])(
    "requires matching %s credentials across the service boundary", async (role) => {
      const input = await fixture();
      const native = nativeServiceConfig();
      const ci = native.ci as Record<string, unknown>;
      const selected = ci[role] as Record<string, unknown>;
      await writePrivate(input.paths.nativeConfig, `${JSON.stringify({ ...native, ci: {
        ...ci, [role]: { ...selected, password: Buffer.alloc(32, 80).toString("base64url") }
      } })}\n`);
      await expect(readControlPlaneSources(input.parsed)).rejects.toThrow(/paired/);
    });

  it("includes runtime-independent worker credentials in redaction and activation fences", async () => {
    const input = await fixture();
    const sources = await readControlPlaneSources(input.parsed);
    expect(sources.credentialValues).toContain(controlPlaneSecrets.host);
    expect(sources.roleValues).toContain("host-a");
    expect(() => completeControlPlaneSourcePreflight(sources, {
      nativeGit: Buffer.from(`${controlPlaneSecrets.host}\n`),
      ordinaryCi: Buffer.from(`${controlPlaneSecrets.ordinaryActivation}\n`)
    })).toThrow(/distinct/);
    const ordinary = ordinaryServiceConfig();
    const workers = ordinary.workers as Array<Record<string, unknown>>;
    await writePrivate(input.paths.ordinaryConfig, `${JSON.stringify({ ...ordinary, workers: [
      { ...workers[0], id: "native-query" }
    ] })}\n`);
    await expect(readControlPlaneSources(input.parsed)).rejects.toThrow(/distinct/);
  });

  it.each(["ordinaryCi", "qemuCi"])("rejects the obsolete separate %s service role shape", async (role) => {
    const input = await fixture();
    await writePrivate(input.paths.nativeConfig, `${JSON.stringify({ ...nativeServiceConfig(), [role]: {} })}\n`);
    await expect(readControlPlaneSources(input.parsed)).rejects.toThrow(/fields/);
  });

  it("reads four stable private sources and records their exact digests", async () => {
    const input = await fixture();
    const sources = await readControlPlaneSources(input.parsed);

    expect(sources.nativeGit.config.sha256).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(sources.nativeGit.readinessToken.value).toBe(controlPlaneSecrets.nativeReadiness);
    expect(sources.ordinaryCi.readinessToken.value).toBe(controlPlaneSecrets.ordinaryReadiness);
    expect(sources.serviceConfigPreflight.kind).toBe("requires-image-validation");
    expect(sources.credentialValues).toContain(controlPlaneSecrets.candidateReader);
    expect(sources.roleValues).toContain("ordinary-candidate-reader");

    const complete = completeControlPlaneSourcePreflight(sources, {
      nativeGit: Buffer.from(`${controlPlaneSecrets.nativeActivation}\n`),
      ordinaryCi: Buffer.from(`${controlPlaneSecrets.ordinaryActivation}\n`)
    });
    expect(complete.allSecretValues).toHaveLength(10);
  });

  it("rejects noncanonical, short, reused, and symlinked token sources", async () => {
    const input = await fixture();
    await writePrivate(input.paths.nativeReadiness, `${Buffer.alloc(31, 8).toString("base64url")}\n`);
    await expect(readControlPlaneSources(input.parsed)).rejects.toThrow(/token/);

    await writePrivate(input.paths.nativeReadiness, `${controlPlaneSecrets.query}\n`);
    await expect(readControlPlaneSources(input.parsed)).rejects.toThrow(/distinct/);

    const target = join(join(input.configPath, ".."), "target.token");
    await writePrivate(target, `${controlPlaneSecrets.nativeReadiness}\n`);
    await rm(input.paths.nativeReadiness);
    await symlink(target, input.paths.nativeReadiness);
    await expect(readControlPlaneSources(input.parsed)).rejects.toThrow();
  });

  it("rejects malformed service JSON, oversized files, and colliding activation tokens", async () => {
    const input = await fixture();
    await writePrivate(input.paths.nativeConfig, "{\n");
    await expect(readControlPlaneSources(input.parsed)).rejects.toThrow(/JSON/);

    await writePrivate(input.paths.nativeConfig, "x".repeat(1_048_577));
    await expect(readControlPlaneSources(input.parsed)).rejects.toThrow(/large/);

    const restored = await fixture();
    const sources = await readControlPlaneSources(restored.parsed);
    expect(() => completeControlPlaneSourcePreflight(sources, {
      nativeGit: Buffer.from(`${controlPlaneSecrets.nativeReadiness}\n`),
      ordinaryCi: Buffer.from(`${controlPlaneSecrets.ordinaryActivation}\n`)
    })).toThrow(/distinct/);
  });

  it("rejects a credential reused for a different service role", async () => {
    // Given
    const input = await fixture();
    const ordinary = ordinaryServiceConfig();
    const credentials = Reflect.get(ordinary, "credentials") as Readonly<Record<string, unknown>>;
    await writePrivate(input.paths.ordinaryConfig, `${JSON.stringify({ ...ordinary, credentials: {
      ...credentials, query: { username: "native-query", password: controlPlaneSecrets.host }
    } })}\n`);

    // When
    const action = readControlPlaneSources(input.parsed);

    // Then
    await expect(action).rejects.toThrow(/paired|distinct/);
  });

  it("rejects the obsolete ordinary config schema without changing operator input", async () => {
    const input = await fixture();
    await writePrivate(input.paths.ordinaryConfig, `${JSON.stringify({
      ...ordinaryServiceConfig(), schemaVersion: 3
    })}\n`);
    const before = await readFile(input.paths.ordinaryConfig);

    await expect(readControlPlaneSources(input.parsed)).rejects.toThrow(/schema-1/);
    expect(await readFile(input.paths.ordinaryConfig)).toEqual(before);
  });

  it("rejects obsolete, missing, and unknown native role fields without changing operator input", async () => {
    const mutations = [
      { ...nativeServiceConfig(), repositories: [] },
      { ...nativeServiceConfig(), identities: [] },
      { ...nativeServiceConfig(), schemaVersion: 5 },
      Object.fromEntries(Object.entries(nativeServiceConfig()).filter(([key]) => key !== "projectRegistrars")),
      Object.fromEntries(Object.entries(nativeServiceConfig()).filter(([key]) => key !== "projectRootImporters")),
      Object.fromEntries(Object.entries(nativeServiceConfig()).filter(([key]) => key !== "projectRootReadIssuers")),
      Object.fromEntries(Object.entries(nativeServiceConfig()).filter(([key]) => key !== "workspaceWriteIssuers")),
      Object.fromEntries(Object.entries(nativeServiceConfig()).filter(([key]) => key !== "humanReviewers")),
      { ...nativeServiceConfig(), projectRegistrars: [{
        hostId: "controller-a", username: "project-registrar-a",
        password: controlPlaneSecrets.projectRegistrar, extra: true
      }] },
      { ...nativeServiceConfig(), projectRootImporters: [{
        hostId: "controller-a", username: "project-root-importer-a",
        password: controlPlaneSecrets.projectRootImporter, extra: true
      }] },
      { ...nativeServiceConfig(), projectRootReadIssuers: [{
        hostId: "controller-a", username: "project-root-read-issuer-a",
        password: controlPlaneSecrets.projectRootReadIssuer, extra: true
      }] },
      { ...nativeServiceConfig(), workspaceWriteIssuers: [{
        hostId: "controller-a", username: "workspace-write-issuer-a",
        password: controlPlaneSecrets.workspaceWriteIssuer, extra: true
      }] },
      { ...nativeServiceConfig(), humanReviewers: [{
        reviewerId: "owner", username: "human-reviewer-owner",
        password: controlPlaneSecrets.humanReviewer, extra: true
      }] }
    ];
    for (const mutation of mutations) {
      const input = await fixture();
      await writePrivate(input.paths.nativeConfig, `${JSON.stringify(mutation)}\n`);
      const before = await readFile(input.paths.nativeConfig);

      await expect(readControlPlaneSources(input.parsed)).rejects.toThrow(/schema-7|fields/);
      expect(await readFile(input.paths.nativeConfig)).toEqual(before);
    }
  });

  it.each([
    ["host IDs", { hostId: "controller-a", username: "project-registrar-b", password: controlPlaneSecrets.nativeActivation }],
    ["usernames", { hostId: "controller-b", username: "project-registrar-a", password: controlPlaneSecrets.nativeActivation }],
    ["passwords", { hostId: "controller-b", username: "project-registrar-b", password: controlPlaneSecrets.projectRegistrar }],
    ["service identifiers", { hostId: "native-query", username: "project-registrar-b", password: controlPlaneSecrets.nativeActivation }],
    ["service secrets", { hostId: "controller-b", username: "project-registrar-b", password: controlPlaneSecrets.query }],
    ["ordinary host identifiers", { hostId: "controller-b", username: "host-a", password: controlPlaneSecrets.nativeActivation }],
    ["host secrets", { hostId: "controller-b", username: "project-registrar-b", password: controlPlaneSecrets.host }]
  ])("rejects duplicate project registrar %s", async (_label, secondRegistrar) => {
    const input = await fixture();
    const firstRegistrar = {
      hostId: "controller-a", username: "project-registrar-a", password: controlPlaneSecrets.projectRegistrar
    };
    await writePrivate(input.paths.nativeConfig, `${JSON.stringify({
      ...nativeServiceConfig(), projectRegistrars: [firstRegistrar, secondRegistrar]
    })}\n`);

    await expect(readControlPlaneSources(input.parsed)).rejects.toThrow(/distinct/);
  });

  it("rejects generated activation tokens colliding with registrar identifiers", async () => {
    const input = await fixture();
    await writePrivate(input.paths.nativeConfig, `${JSON.stringify({
      ...nativeServiceConfig(), projectRegistrars: [{
        hostId: "controller-a", username: controlPlaneSecrets.nativeActivation,
        password: controlPlaneSecrets.projectRegistrar
      }]
    })}\n`);
    const sources = await readControlPlaneSources(input.parsed);

    expect(() => completeControlPlaneSourcePreflight(sources, {
      nativeGit: Buffer.from(`${controlPlaneSecrets.nativeActivation}\n`),
      ordinaryCi: Buffer.from(`${controlPlaneSecrets.ordinaryActivation}\n`)
    })).toThrow(/distinct/);
  });

  it("allows a Project registrar to bind the same trusted host as ordinary CI with distinct credentials", async () => {
    const input = await fixture();
    await writePrivate(input.paths.nativeConfig, `${JSON.stringify({
      ...nativeServiceConfig(), projectRegistrars: [{
        hostId: "host-a", username: "project-registrar-a", password: controlPlaneSecrets.projectRegistrar
      }]
    })}\n`);

    const sources = await readControlPlaneSources(input.parsed);

    expect(sources.credentialValues).toContain(controlPlaneSecrets.projectRegistrar);
    expect(sources.nativeGit.config.bytes).toEqual(await readFile(input.paths.nativeConfig));
  });

  it("binds registrar changes to exact source bytes and the generation digest", async () => {
    const input = await fixture();
    const registrar = {
      hostId: "controller-a", username: "project-registrar-a", password: controlPlaneSecrets.projectRegistrar
    };
    await writePrivate(input.paths.nativeConfig, `${JSON.stringify({
      ...nativeServiceConfig(), projectRegistrars: [registrar]
    })}\n`);
    const first = await readControlPlaneSources(input.parsed);
    await writePrivate(input.paths.nativeConfig, `${JSON.stringify({
      ...nativeServiceConfig(), projectRegistrars: [{ ...registrar, hostId: "controller-b" }]
    })}\n`);
    const second = await readControlPlaneSources(input.parsed);
    const activationBytes = {
      nativeGit: Buffer.from(`${controlPlaneSecrets.nativeActivation}\n`),
      ordinaryCi: Buffer.from(`${controlPlaneSecrets.ordinaryActivation}\n`)
    };

    expect(first.nativeGit.config.bytes).not.toEqual(second.nativeGit.config.bytes);
    expect(second.nativeGit.config.bytes).toEqual(await readFile(input.paths.nativeConfig));
    expect(controlPlaneGenerationId(input.parsed, completeControlPlaneSourcePreflight(first, activationBytes)))
      .not.toBe(controlPlaneGenerationId(input.parsed, completeControlPlaneSourcePreflight(second, activationBytes)));
  });

  it.each([
    ["native service secret", controlPlaneSecrets.query],
    ["native registrar secret", controlPlaneSecrets.projectRegistrar],
    ["ordinary host token", controlPlaneSecrets.host],
    ["native readiness token", controlPlaneSecrets.nativeReadiness],
    ["ordinary readiness token", controlPlaneSecrets.ordinaryReadiness]
  ])("rejects a root importer reused as a %s", async (_label, password) => {
    // Given
    const input = await fixture();
    await writePrivate(input.paths.nativeConfig, `${JSON.stringify({
      ...nativeServiceConfig(),
      projectRegistrars: [{
        hostId: "host-a", username: "project-registrar-a", password: controlPlaneSecrets.projectRegistrar
      }],
      projectRootImporters: [{ hostId: "host-a", username: "project-root-importer-a", password }]
    })}\n`);

    // When
    const action = readControlPlaneSources(input.parsed);

    // Then
    await expect(action).rejects.toThrow(/distinct/);
  });

  it.each([
    ["native service role", "native-query"],
    ["native registrar role", "project-registrar-a"]
  ])("rejects a root importer username reused as a %s", async (_label, username) => {
    // Given
    const input = await fixture();
    await writePrivate(input.paths.nativeConfig, `${JSON.stringify({
      ...nativeServiceConfig(),
      projectRegistrars: [{
        hostId: "host-a", username: "project-registrar-a", password: controlPlaneSecrets.projectRegistrar
      }],
      projectRootImporters: [{
        hostId: "host-a", username, password: controlPlaneSecrets.projectRootImporter
      }]
    })}\n`);

    // When
    const action = readControlPlaneSources(input.parsed);

    // Then
    await expect(action).rejects.toThrow(/distinct/);
  });

  it.each([
    ["native activation token", controlPlaneSecrets.nativeActivation],
    ["ordinary activation token", controlPlaneSecrets.ordinaryActivation]
  ])("rejects a root importer reused as the generated %s", async (_label, password) => {
    // Given
    const input = await fixture();
    await writePrivate(input.paths.nativeConfig, `${JSON.stringify({
      ...nativeServiceConfig(),
      projectRootImporters: [{ hostId: "host-a", username: "project-root-importer-a", password }]
    })}\n`);
    const sources = await readControlPlaneSources(input.parsed);

    // When
    const action = () => completeControlPlaneSourcePreflight(sources, {
      nativeGit: Buffer.from(`${controlPlaneSecrets.nativeActivation}\n`),
      ordinaryCi: Buffer.from(`${controlPlaneSecrets.ordinaryActivation}\n`)
    });

    // Then
    expect(action).toThrow(/distinct/);
  });

  it("binds root importer changes to the operator source bytes and generation digest", async () => {
    // Given
    const input = await fixture();
    const importer = {
      hostId: "host-a", username: "project-root-importer-a", password: controlPlaneSecrets.projectRootImporter
    };
    await writePrivate(input.paths.nativeConfig, `${JSON.stringify({
      ...nativeServiceConfig(), projectRootImporters: [importer]
    })}\n`);
    const first = await readControlPlaneSources(input.parsed);
    await writePrivate(input.paths.nativeConfig, `${JSON.stringify({
      ...nativeServiceConfig(), projectRootImporters: [{ ...importer, hostId: "host-b" }]
    })}\n`);
    const second = await readControlPlaneSources(input.parsed);
    const activationBytes = {
      nativeGit: Buffer.from(`${controlPlaneSecrets.nativeActivation}\n`),
      ordinaryCi: Buffer.from(`${controlPlaneSecrets.ordinaryActivation}\n`)
    };

    // When
    const generations = [first, second].map((sources) =>
      controlPlaneGenerationId(input.parsed, completeControlPlaneSourcePreflight(sources, activationBytes)));

    // Then
    expect(first.nativeGit.config.bytes).not.toEqual(second.nativeGit.config.bytes);
    expect(second.nativeGit.config.bytes).toEqual(await readFile(input.paths.nativeConfig));
    expect(generations[0]).not.toBe(generations[1]);
  });

  it.each([
    ["native service secret", controlPlaneSecrets.query],
    ["native registrar secret", controlPlaneSecrets.projectRegistrar],
    ["root importer secret", controlPlaneSecrets.projectRootImporter],
    ["ordinary host token", controlPlaneSecrets.host],
    ["native readiness token", controlPlaneSecrets.nativeReadiness],
    ["ordinary readiness token", controlPlaneSecrets.ordinaryReadiness]
  ])("rejects a root read issuer reused as a %s", async (_label, password) => {
    // Given
    const input = await fixture();
    await writePrivate(input.paths.nativeConfig, `${JSON.stringify({
      ...nativeServiceConfig(),
      projectRegistrars: [{
        hostId: "host-a", username: "project-registrar-a", password: controlPlaneSecrets.projectRegistrar
      }],
      projectRootImporters: [{
        hostId: "host-a", username: "project-root-importer-a", password: controlPlaneSecrets.projectRootImporter
      }],
      projectRootReadIssuers: [{ hostId: "host-a", username: "project-root-read-issuer-a", password }]
    })}\n`);

    // When
    const action = readControlPlaneSources(input.parsed);

    // Then
    await expect(action).rejects.toThrow(/distinct/);
  });

  it.each([
    ["native service role", "native-query"],
    ["native registrar role", "project-registrar-a"],
    ["root importer role", "project-root-importer-a"]
  ])("rejects a root read issuer username reused as a %s", async (_label, username) => {
    // Given
    const input = await fixture();
    await writePrivate(input.paths.nativeConfig, `${JSON.stringify({
      ...nativeServiceConfig(),
      projectRegistrars: [{
        hostId: "host-a", username: "project-registrar-a", password: controlPlaneSecrets.projectRegistrar
      }],
      projectRootImporters: [{
        hostId: "host-a", username: "project-root-importer-a", password: controlPlaneSecrets.projectRootImporter
      }],
      projectRootReadIssuers: [{ hostId: "host-a", username, password: controlPlaneSecrets.projectRootReadIssuer }]
    })}\n`);

    // When
    const action = readControlPlaneSources(input.parsed);

    // Then
    await expect(action).rejects.toThrow(/distinct/);
  });

  it.each([
    ["native activation token", controlPlaneSecrets.nativeActivation],
    ["ordinary activation token", controlPlaneSecrets.ordinaryActivation]
  ])("rejects a root read issuer reused as the generated %s", async (_label, password) => {
    // Given
    const input = await fixture();
    await writePrivate(input.paths.nativeConfig, `${JSON.stringify({
      ...nativeServiceConfig(),
      projectRootReadIssuers: [{ hostId: "host-a", username: "project-root-read-issuer-a", password }]
    })}\n`);
    const sources = await readControlPlaneSources(input.parsed);

    // When
    const action = () => completeControlPlaneSourcePreflight(sources, {
      nativeGit: Buffer.from(`${controlPlaneSecrets.nativeActivation}\n`),
      ordinaryCi: Buffer.from(`${controlPlaneSecrets.ordinaryActivation}\n`)
    });

    // Then
    expect(action).toThrow(/distinct/);
  });

  it.each([
    ["native service secret", controlPlaneSecrets.query],
    ["native registrar secret", controlPlaneSecrets.projectRegistrar],
    ["root importer secret", controlPlaneSecrets.projectRootImporter],
    ["root read issuer secret", controlPlaneSecrets.projectRootReadIssuer],
    ["ordinary host token", controlPlaneSecrets.host]
  ])("rejects a workspace write issuer reused as a %s", async (_label, password) => {
    const input = await fixture();
    await writePrivate(input.paths.nativeConfig, `${JSON.stringify({
      ...nativeServiceConfig(),
      projectRegistrars: [{
        hostId: "host-a", username: "project-registrar-a", password: controlPlaneSecrets.projectRegistrar
      }],
      projectRootImporters: [{
        hostId: "host-a", username: "project-root-importer-a", password: controlPlaneSecrets.projectRootImporter
      }],
      projectRootReadIssuers: [{
        hostId: "host-a", username: "project-root-read-issuer-a", password: controlPlaneSecrets.projectRootReadIssuer
      }],
      workspaceWriteIssuers: [{ hostId: "host-a", username: "workspace-write-issuer-a", password }]
    })}\n`);

    await expect(readControlPlaneSources(input.parsed)).rejects.toThrow(/distinct/);
  });

  it("accepts schema-7 human reviewers and binds them into the generation source", async () => {
    // Given
    const input = await fixture();
    const humanReviewers = [{
      reviewerId: "owner", username: "human-reviewer-owner", password: controlPlaneSecrets.humanReviewer
    }];
    await writePrivate(input.paths.nativeConfig, `${JSON.stringify({
      ...nativeServiceConfig(), humanReviewers
    })}\n`);

    // When
    const sources = await readControlPlaneSources(input.parsed);

    // Then
    expect(sources.credentialValues).toContain(controlPlaneSecrets.humanReviewer);
    expect(sources.roleValues).toEqual(expect.arrayContaining([
      "owner", "human-reviewer-owner", controlPlaneSecrets.humanReviewer
    ]));
  });

  it.each([
    ["reviewer ID", { reviewerId: "owner", username: "human-reviewer-two", password: controlPlaneSecrets.nativeActivation }],
    ["username", { reviewerId: "reviewer-two", username: "human-reviewer-owner", password: controlPlaneSecrets.nativeActivation }],
    ["service credential", { reviewerId: "reviewer-two", username: "human-reviewer-two", password: controlPlaneSecrets.query }]
  ])("rejects a duplicate human reviewer %s", async (_label, second) => {
    // Given
    const input = await fixture();
    await writePrivate(input.paths.nativeConfig, `${JSON.stringify({
      ...nativeServiceConfig(),
      humanReviewers: [{
        reviewerId: "owner", username: "human-reviewer-owner", password: controlPlaneSecrets.humanReviewer
      }, second]
    })}\n`);

    // When / Then
    await expect(readControlPlaneSources(input.parsed)).rejects.toThrow(/distinct/);
  });

  it("accepts a schema-7 host promoter and binds every identity value into the generation source", async () => {
    // Given
    const input = await fixture();
    await writePrivate(input.paths.nativeConfig, `${JSON.stringify({
      ...nativeServiceConfig(),
      hostPromoters: [{ hostId: "host-a", username: "host-promoter-a", password: controlPlaneSecrets.hostPromoter }]
    })}\n`);

    // When
    const sources = await readControlPlaneSources(input.parsed);

    // Then
    expect(sources.credentialValues).toContain(controlPlaneSecrets.hostPromoter);
    expect(sources.roleValues).toEqual(expect.arrayContaining([
      "host-a", "host-promoter-a", controlPlaneSecrets.hostPromoter
    ]));
  });

  it.each([
    ["host ID", { hostId: "native-query", username: "host-promoter-a", password: controlPlaneSecrets.hostPromoter }],
    ["username", { hostId: "host-a", username: "native-query", password: controlPlaneSecrets.hostPromoter }],
    ["service credential", { hostId: "host-a", username: "host-promoter-a", password: controlPlaneSecrets.query }]
  ])("rejects a host promoter colliding by %s", async (_label, promoter) => {
    // Given
    const input = await fixture();
    await writePrivate(input.paths.nativeConfig, `${JSON.stringify({
      ...nativeServiceConfig(), hostPromoters: [promoter]
    })}\n`);

    // When / Then
    await expect(readControlPlaneSources(input.parsed)).rejects.toThrow(/distinct/);
  });
});
