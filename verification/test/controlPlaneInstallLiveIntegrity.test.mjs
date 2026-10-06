import { strict as assert } from "node:assert";
import { describe, it } from "vitest";
import {
  assertEffectiveComposeModel,
  nonexistentDigestReference
} from "../scripts/control-plane-install-live-integrity.mjs";

const stateRoot = "/test/state/dim/control-plane";
const generationId = "a".repeat(64);
const deploymentId = "live-test";
const images = {
  nativeGit: `registry.test/native-git@sha256:${"1".repeat(64)}`,
  ordinaryCi: `registry.test/ordinary-ci@sha256:${"2".repeat(64)}`
};
const record = {
  generationId,
  deploymentId,
  nativeGitImage: images.nativeGit,
  ordinaryCiImage: images.ordinaryCi,
  nativeGitPublish: { host: "127.0.0.1", port: 31001 },
  ordinaryCiPublish: { host: "127.0.0.1", port: 31002 }
};

describe("control-plane live integrity evidence", () => {
  it("constructs a syntactically valid nonexistent digest in the known repository", () => {
    const wrong = nonexistentDigestReference(images.nativeGit);

    assert.match(wrong, /^registry\.test\/native-git@sha256:[0-9a-f]{64}$/);
    assert.notEqual(wrong, images.nativeGit);
    assert.equal(wrong.split("@", 1)[0], images.nativeGit.split("@", 1)[0]);
  });

  it("accepts the exact effective two-service Compose model", () => {
    assert.doesNotThrow(() => assertEffectiveComposeModel({
      model: effectiveModel(), stateRoot, record,
      operatorPaths: ["/test/operator/native.json", "/test/operator/ordinary.json"],
      forbiddenValues: ["native-secret", "ordinary-secret"]
    }));
  });

  it("rejects environment and socket leaks in the effective model", () => {
    const model = effectiveModel();
    model.services["native-git"].environment = { TOKEN: "native-secret" };
    model.services["native-git"].volumes.push({
      type: "bind", source: "/run/docker.sock", target: "/run/docker.sock"
    });

    assert.throws(() => assertEffectiveComposeModel({
      model, stateRoot, record,
      operatorPaths: ["/test/operator/native.json", "/test/operator/ordinary.json"],
      forbiddenValues: ["native-secret", "ordinary-secret"]
    }));
  });
});

function effectiveModel() {
  return {
    name: "dim-control-plane",
    networks: {
      "dim-control-plane": {
        name: "dim-control-plane", driver: "bridge", ipam: {},
        labels: labels("network")
      }
    },
    volumes: {
      "dim-control-plane-native-git-data": {
        name: "dim-control-plane-native-git-data", labels: labels("volume", "native-git")
      },
      "dim-control-plane-ordinary-ci-data": {
        name: "dim-control-plane-ordinary-ci-data", labels: labels("volume", "ordinary-ci")
      }
    },
    services: {
      "native-git": service("native-git", "10001:10001", images.nativeGit, 31001),
      "ordinary-ci": service("ordinary-ci", "10002:10002", images.ordinaryCi, 31002)
    }
  };
}

function service(name, user, image, published) {
  const prefix = `${stateRoot}/generations/${generationId}/${name}`;
  const stateTarget = name === "native-git" ? "/var/lib/dim-native-git" : "/var/lib/dim-ordinary-ci";
  return {
    image,
    command: ["serve", "/run/secrets/service.json", generationId],
    user,
    read_only: true,
    cap_drop: ["ALL"],
    security_opt: ["no-new-privileges:true"],
    tmpfs: ["/tmp:rw,nosuid,nodev,noexec,mode=1777"],
    ports: [{ mode: "ingress", target: 8080, published: String(published), protocol: "tcp", host_ip: "127.0.0.1" }],
    networks: { "dim-control-plane": null },
    labels: labels("service", name),
    volumes: [
      { type: "bind", source: `${prefix}.json`, target: "/run/secrets/service.json", read_only: true },
      { type: "bind", source: `${prefix}-readiness.token`, target: "/run/secrets/readiness.token", read_only: true },
      { type: "bind", source: `${prefix}-activation.token`, target: "/run/secrets/activation.token", read_only: true },
      { type: "volume", source: `dim-control-plane-${name}-data`, target: stateTarget, volume: {} }
    ]
  };
}

function labels(resource, service) {
  return {
    "org.dim.managed": "true",
    "org.dim.bundle": "control-plane",
    "org.dim.deployment": deploymentId,
    "org.dim.resource": resource,
    ...(service === undefined ? {} : { "org.dim.service": service })
  };
}
