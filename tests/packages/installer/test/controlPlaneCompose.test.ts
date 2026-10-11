import { describe, expect, it } from "vitest";
import { parseControlPlaneConfig } from "../../../../core/packages/installer/src/controlPlaneConfig.js";
import { renderControlPlaneCompose } from "../../../../core/packages/installer/src/controlPlaneCompose.js";
import { controlPlaneSecrets } from "./controlPlaneFixture.js";

const config = parseControlPlaneConfig({
  schemaVersion: 1,
  deploymentId: "main",
  nativeGit: {
    image: `registry.example/dim/native-git@sha256:${"a".repeat(64)}`,
    configFile: "/operator/native.json",
    readinessTokenFile: "/operator/native.token",
    publish: { host: "127.0.0.1", port: 7443 }
  },
  ordinaryCi: {
    image: `registry.example/dim/ordinary-ci@sha256:${"b".repeat(64)}`,
    configFile: "/operator/ordinary.json",
    readinessTokenFile: "/operator/ordinary.token",
    publish: { host: "::1", port: 7410 }
  }
}, ["127.0.0.1", "::1"]);

const snapshots = {
  nativeGit: {
    config: "/state/generations/abc/native-git.json",
    readinessToken: "/state/generations/abc/native-git-readiness.token",
    activationToken: "/state/generations/abc/native-git-activation.token"
  },
  ordinaryCi: {
    config: "/state/generations/abc/ordinary-ci.json",
    readinessToken: "/state/generations/abc/ordinary-ci-readiness.token",
    activationToken: "/state/generations/abc/ordinary-ci-activation.token"
  }
} as const;
const generationId = "c".repeat(64);

describe("control-plane Compose rendering", () => {
  it("renders deterministic exact two-service private topology and security", () => {
    const input = { generationId, config, snapshots, operatorSourcePaths: operatorPaths(), forbiddenSecrets: Object.values(controlPlaneSecrets) };
    const first = renderControlPlaneCompose(input);
    const second = renderControlPlaneCompose(input);

    expect(first.equals(second)).toBe(true);
    const yaml = first.toString("utf8");
    expect(yaml).toContain('name: "dim-control-plane"');
    expect(yaml.match(/^  (native-git|ordinary-ci):$/gm)).toHaveLength(2);
    expect(yaml).toContain('user: "10001:10001"');
    expect(yaml).toContain('user: "10002:10002"');
    expect(yaml.match(/- "serve"/g)).toHaveLength(2);
    expect(yaml.match(new RegExp(`- "${generationId}"`, "g"))).toHaveLength(2);
    expect(yaml.match(/^    read_only: true$/gm)).toHaveLength(2);
    expect(yaml.match(/- "ALL"/g)).toHaveLength(2);
    expect(yaml.match(/- "no-new-privileges:true"/g)).toHaveLength(2);
    expect(yaml.match(/\/tmp:rw,nosuid,nodev,noexec/g)).toHaveLength(2);
    expect(yaml).toContain('name: "dim-control-plane-native-git-data"');
    expect(yaml).toContain('name: "dim-control-plane-ordinary-ci-data"');
    expect(yaml).toContain('name: "dim-control-plane"');
    expect(yaml).not.toContain("/operator/");
    for (const secret of Object.values(controlPlaneSecrets)) expect(yaml).not.toContain(secret);
  });

  it("renders full exact labels and service-private mounts", () => {
    const yaml = renderControlPlaneCompose({ generationId, config, snapshots, operatorSourcePaths: operatorPaths(), forbiddenSecrets: [] }).toString("utf8");

    expect(yaml.match(/org\.dim\.managed: "true"/g)).toHaveLength(5);
    expect(yaml.match(/org\.dim\.bundle: "control-plane"/g)).toHaveLength(5);
    expect(yaml.match(/org\.dim\.deployment: "main"/g)).toHaveLength(5);
    expect(yaml.match(/org\.dim\.resource: "service"/g)).toHaveLength(2);
    expect(yaml.match(/org\.dim\.resource: "volume"/g)).toHaveLength(2);
    expect(yaml.match(/org\.dim\.resource: "network"/g)).toHaveLength(1);
    expect(yaml.match(/target: "\/run\/secrets\/service\.json"/g)).toHaveLength(2);
    expect(yaml.match(/target: "\/run\/secrets\/readiness\.token"/g)).toHaveLength(2);
    expect(yaml.match(/target: "\/run\/secrets\/activation\.token"/g)).toHaveLength(2);
  });

  it("rejects non-absolute, duplicate, operator, and secret-bearing snapshot paths", () => {
    expect(() => renderControlPlaneCompose({
      config,
      generationId,
      snapshots: { ...snapshots, nativeGit: { ...snapshots.nativeGit, config: "relative.json" } },
      operatorSourcePaths: operatorPaths(),
      forbiddenSecrets: []
    })).toThrow();
    expect(() => renderControlPlaneCompose({
      config,
      generationId,
      snapshots: { ...snapshots, nativeGit: { ...snapshots.nativeGit, config: config.nativeGit.configFile } },
      operatorSourcePaths: operatorPaths(),
      forbiddenSecrets: []
    })).toThrow();
    expect(() => renderControlPlaneCompose({
      config,
      generationId,
      snapshots: { ...snapshots, nativeGit: { ...snapshots.nativeGit, config: `/state/${controlPlaneSecrets.query}` } },
      operatorSourcePaths: operatorPaths(),
      forbiddenSecrets: [controlPlaneSecrets.query]
    })).toThrow(/secret/);
  });
});

function operatorPaths(): readonly string[] {
  return [
    config.nativeGit.configFile,
    config.nativeGit.readinessTokenFile,
    config.ordinaryCi.configFile,
    config.ordinaryCi.readinessTokenFile
  ];
}
