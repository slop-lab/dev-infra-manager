const token = (fill: number): string => Buffer.alloc(32, fill).toString("base64url");

export const ordinaryBundleSecrets = {
  identity: token(1),
  attemptIssuer: token(2),
  resultReporter: token(3),
  webhook: token(4),
  registrar: token(5),
  query: token(6),
  host: token(7),
  alternate: token(8)
} as const;

export function ordinaryBundleConfig() {
  return {
    schemaVersion: 4,
    serviceId: "ordinary-main",
    database: "/var/lib/dim-ordinary-ci/ordinary-ci.sqlite3",
    admissionLeaseMilliseconds: 300_000,
    claimLeaseMilliseconds: 60_000,
    nativeGit: {
      endpoint: "http://native-git:8080",
      serviceId: "native-main",
      identity: { username: "ordinary-identity", password: ordinaryBundleSecrets.identity },
      attemptIssuer: { username: "ordinary-attempts", password: ordinaryBundleSecrets.attemptIssuer },
      resultReporter: { username: "ordinary-results", password: ordinaryBundleSecrets.resultReporter }
    },
    credentials: {
      webhook: { username: "native-events", password: ordinaryBundleSecrets.webhook },
      registrar: { username: "ordinary-registrar", password: ordinaryBundleSecrets.registrar },
      query: { username: "native-query", password: ordinaryBundleSecrets.query }
    },
    hosts: [{
      hostId: "host-a",
      hostToken: ordinaryBundleSecrets.host,
      capacities: [{
        capacity: "primary",
        runnerBaseImage: `registry.example/dim/ordinary-runner@sha256:${"c".repeat(64)}`,
        jobBaseImage: `registry.example/dim/ordinary-job@sha256:${"d".repeat(64)}`,
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
