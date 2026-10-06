const token = (fill: number): string => Buffer.alloc(32, fill).toString("base64url");

export const bundleSecrets = {
  nativeQuery: token(1),
  nativeIdentity: token(2),
  attemptIssuer: token(3),
  resultReporter: token(4),
  webhook: token(5),
  registrar: token(6),
  host: token(7),
  unpaired: token(8)
} as const;

export function idleNativeConfig() {
  return {
    schemaVersion: 2,
    serviceId: "native-main",
    host: "0.0.0.0",
    port: 8080,
    storageRoot: "/var/lib/dim-native-git",
    gitExecutable: "/usr/bin/git",
    gitVersion: "2.43.0",
    repositories: [],
    identities: [],
    ordinaryCi: {
      endpoint: "http://ordinary-ci:8080",
      serviceId: "ordinary-main",
      query: { username: "native-query", password: bundleSecrets.nativeQuery },
      identity: { username: "ordinary-identity", password: bundleSecrets.nativeIdentity },
      attemptIssuer: { username: "ordinary-attempts", password: bundleSecrets.attemptIssuer },
      resultReporter: { username: "ordinary-results", password: bundleSecrets.resultReporter },
      webhook: {
        endpoint: "http://ordinary-ci:8080/v1/native-events",
        username: "native-events",
        password: bundleSecrets.webhook
      }
    }
  };
}

export function idleOrdinaryConfig() {
  return {
    schemaVersion: 3,
    serviceId: "ordinary-main",
    database: "/var/lib/dim-ordinary-ci/ordinary-ci.sqlite3",
    admissionLeaseMilliseconds: 300_000,
    claimLeaseMilliseconds: 60_000,
    nativeGit: {
      endpoint: "http://native-git:8080",
      serviceId: "native-main",
      identity: { username: "ordinary-identity", password: bundleSecrets.nativeIdentity },
      attemptIssuer: { username: "ordinary-attempts", password: bundleSecrets.attemptIssuer },
      resultReporter: { username: "ordinary-results", password: bundleSecrets.resultReporter }
    },
    credentials: {
      webhook: { username: "native-events", password: bundleSecrets.webhook },
      registrar: { username: "ordinary-registrar", password: bundleSecrets.registrar },
      query: { username: "native-query", password: bundleSecrets.nativeQuery }
    },
    hosts: [{
      hostId: "host-a",
      hostToken: bundleSecrets.host,
      capacities: [{
        capacity: "primary",
        runnerBaseImage: `registry.example/dim/ordinary-runner@sha256:${"c".repeat(64)}`,
        bounds: {
          cpu: "4",
          memoryBytes: "8589934592",
          pids: "2048",
          wallClockSeconds: "3600",
          outputBytes: "16777216"
        }
      }]
    }]
  };
}
