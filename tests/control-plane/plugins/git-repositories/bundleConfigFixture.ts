import { realGitVersion } from "./realGitIdentity.js";
const token = (fill: number): string => Buffer.alloc(32, fill).toString("base64url");

export const bundleSecrets = {
  nativeQuery: token(1),
  nativeIdentity: token(2),
  attemptIssuer: token(3),
  candidateReader: token(16),
  resultReporter: token(4),
  webhook: token(5),
  registrar: token(6),
  host: token(7),
  unpaired: token(8),
  projectRegistrar: token(9),
  projectRootImporter: token(10),
  projectRootReadIssuer: token(11),
  workspaceWriteIssuer: token(12),
  humanReviewer: token(13),
  foreignHumanReviewer: token(14),
  hostPromoter: token(15)
} as const;

export function idleNativeConfig() {
  return {
    schemaVersion: 7,
    serviceId: "native-main",
    host: "0.0.0.0",
    port: 8080,
    storageRoot: "/var/lib/dim-native-git",
    gitExecutable: "/usr/bin/git",
    gitVersion: realGitVersion,
    projectRegistrars: [],
    projectRootImporters: [],
    projectRootReadIssuers: [],
    workspaceWriteIssuers: [],
    humanReviewers: [],
    hostPromoters: [],
    ci: {
      grantIssuer: { username: "ci-grants", password: bundleSecrets.attemptIssuer },
      candidateReader: { username: "ci-candidate-reader", password: bundleSecrets.candidateReader },
      resultReporter: { username: "ci-results", password: bundleSecrets.resultReporter },
      webhook: { endpoint: "http://ordinary-ci:8080/v1/jobs", username: "native-events", password: bundleSecrets.webhook }
    }
  };
}

export function idleOrdinaryConfig() {
  const native = idleNativeConfig();
  return { schemaVersion: 1, claimLeaseMilliseconds: 60_000,
    nativeGit: { endpoint: "http://native-git:8080", grantIssuer: native.ci.grantIssuer,
      candidateReader: native.ci.candidateReader, resultReporter: native.ci.resultReporter },
    credentials: { webhook: { username: native.ci.webhook.username, password: native.ci.webhook.password },
      query: { username: "ci-query", password: bundleSecrets.nativeQuery }, operator: { username: "ci-operator", password: token(59) } },
    workers: [{ id: "host-a", token: bundleSecrets.host, slots: [{ id: "primary", runtime: "container",
      profile: { runnerBaseImage: `registry.example/runner@sha256:${"c".repeat(64)}`,
        jobBaseImage: `registry.example/job@sha256:${"d".repeat(64)}`,
        bounds: { cpu: "4", memoryBytes: "8589934592", pids: "2048", wallClockSeconds: "3600", outputBytes: "16777216" } }
    }] }]
  };
}
