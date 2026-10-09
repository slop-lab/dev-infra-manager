import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { chmod, writeFile } from "node:fs/promises";
import { join } from "node:path";

export async function createOperatorFixture(input) {
  const credentials = Object.fromEntries(
    ["query", "identity", "attemptIssuer", "resultReporter", "webhook", "registrar", "host"]
      .map((name) => [name, randomBytes(32).toString("base64url")])
  );
  const readinessTokens = {
    nativeGit: randomBytes(32).toString("base64url"),
    ordinaryCi: randomBytes(32).toString("base64url")
  };
  const sources = {
    nativeGit: join(input.operatorRoot, "native-git.json"),
    nativeReadiness: join(input.operatorRoot, "native-readiness.token"),
    ordinaryCi: join(input.operatorRoot, "ordinary-ci.json"),
    ordinaryReadiness: join(input.operatorRoot, "ordinary-readiness.token")
  };
  await privateFile(sources.nativeGit, JSON.stringify({
    schemaVersion: 7, serviceId: "native-main", host: "0.0.0.0", port: 8080,
    storageRoot: "/var/lib/dim-native-git", gitExecutable: "/usr/bin/git", gitVersion: "2.39.5",
    repositories: [], identities: [], projectRegistrars: [], projectRootImporters: [],
    projectRootReadIssuers: [], workspaceWriteIssuers: [], humanReviewers: [], ordinaryCi: {
      endpoint: "http://ordinary-ci:8080", serviceId: "ordinary-main",
      query: { username: "native-query", password: credentials.query },
      identity: { username: "ordinary-identity", password: credentials.identity },
      attemptIssuer: { username: "ordinary-attempts", password: credentials.attemptIssuer },
      resultReporter: { username: "ordinary-results", password: credentials.resultReporter },
      webhook: { endpoint: "http://ordinary-ci:8080/v1/native-events", username: "native-events", password: credentials.webhook }
    }
  }));
  await privateFile(sources.ordinaryCi, JSON.stringify({
    schemaVersion: 4, serviceId: "ordinary-main", database: "/var/lib/dim-ordinary-ci/ordinary-ci.sqlite3",
    admissionLeaseMilliseconds: 300000, claimLeaseMilliseconds: 60000,
    nativeGit: {
      endpoint: "http://native-git:8080", serviceId: "native-main",
      identity: { username: "ordinary-identity", password: credentials.identity },
      attemptIssuer: { username: "ordinary-attempts", password: credentials.attemptIssuer },
      resultReporter: { username: "ordinary-results", password: credentials.resultReporter }
    },
    credentials: {
      webhook: { username: "native-events", password: credentials.webhook },
      registrar: { username: "ordinary-registrar", password: credentials.registrar },
      query: { username: "native-query", password: credentials.query }
    },
    hosts: [{ hostId: "host-a", hostToken: credentials.host, capacities: [{ capacity: "primary", runnerBaseImage: `registry.example/runner@sha256:${"c".repeat(64)}`, jobBaseImage: `registry.example/job@sha256:${"d".repeat(64)}`, bounds: { cpu: "4", memoryBytes: "8589934592", pids: "2048", wallClockSeconds: "3600", outputBytes: "16777216" } }] }]
  }));
  await privateFile(sources.nativeReadiness, readinessTokens.nativeGit);
  await privateFile(sources.ordinaryReadiness, readinessTokens.ordinaryCi);

  return {
    credentials,
    readinessTokens,
    sources,
    writeConfig: async (selectedImages, ports = input.ports) => privateFile(input.configPath, JSON.stringify({
      schemaVersion: 1, deploymentId: input.deploymentId,
      nativeGit: {
        image: selectedImages.nativeGit, configFile: sources.nativeGit,
        readinessTokenFile: sources.nativeReadiness, publish: { host: "127.0.0.1", port: ports.nativeGit }
      },
      ordinaryCi: {
        image: selectedImages.ordinaryCi, configFile: sources.ordinaryCi,
        readinessTokenFile: sources.ordinaryReadiness, publish: { host: "127.0.0.1", port: ports.ordinaryCi }
      }
    }))
  };
}

export function requiredEnvironment(name) {
  const value = process.env[name];
  assert.notEqual(value, undefined, `${name} is required`);
  return value;
}

export function digestReference(name) {
  const value = requiredEnvironment(name);
  assert.match(value, /^127\.0\.0\.1:[0-9]+\/[a-z0-9/_-]+@sha256:[0-9a-f]{64}$/);
  return value;
}

export function controlPlaneFacadeEnvironment(input) {
  return {
    ...input.environment,
    HOME: input.home,
    PATH: input.path,
    XDG_STATE_HOME: input.stateHome,
    DIM_STATE_ROOT: input.lifecycleStateRoot
  };
}

async function privateFile(path, contents) {
  await writeFile(path, `${contents}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
}
