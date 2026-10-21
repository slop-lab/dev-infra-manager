import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const token = (fill: number): string => Buffer.alloc(32, fill).toString("base64url");

export const controlPlaneSecrets = {
  query: token(1),
  operator: token(19),
  grantIssuer: token(3),
  candidateReader: token(18),
  resultReporter: token(4),
  webhook: token(5),
  registrar: token(6),
  host: token(7),
  nativeReadiness: token(8),
  executionReadiness: token(9),
  nativeActivation: token(10),
  executionActivation: token(11),
  projectRegistrar: token(12),
  projectRootImporter: token(13),
  projectRootReadIssuer: token(14),
  workspaceWriteIssuer: token(15),
  humanReviewer: token(16),
  hostPromoter: token(17)
} as const;

export function nativeServiceConfig(): Readonly<Record<string, unknown>> {
  return {
    schemaVersion: 7,
    serviceId: "native-main",
    host: "0.0.0.0",
    port: 8080,
    storageRoot: "/var/lib/dim-native-git",
    gitExecutable: "/usr/bin/git",
    gitVersion: "2.39.5",
    projectRegistrars: [],
    projectRootImporters: [],
    projectRootReadIssuers: [],
    workspaceWriteIssuers: [],
    humanReviewers: [],
    hostPromoters: [],
    ci: {
      grantIssuer: { username: "ci-grants", password: controlPlaneSecrets.grantIssuer },
      candidateReader: { username: "execution-candidate-reader", password: controlPlaneSecrets.candidateReader },
      resultReporter: { username: "execution-results", password: controlPlaneSecrets.resultReporter },
      webhook: {
        endpoint: "http://execution:8080/v1/jobs",
        username: "native-events",
        password: controlPlaneSecrets.webhook
      }
    }
  };
}

export function executionServiceConfig(): Readonly<Record<string, unknown>> {
  return {
    schemaVersion: 1,
    claimLeaseMilliseconds: 60_000,
    nativeGit: {
      endpoint: "http://native-git:8080",
      grantIssuer: { username: "ci-grants", password: controlPlaneSecrets.grantIssuer },
      candidateReader: { username: "execution-candidate-reader", password: controlPlaneSecrets.candidateReader },
      resultReporter: { username: "execution-results", password: controlPlaneSecrets.resultReporter }
    },
    credentials: {
      webhook: { username: "native-events", password: controlPlaneSecrets.webhook },
      query: { username: "native-query", password: controlPlaneSecrets.query },
      operator: { username: "ci-operator", password: controlPlaneSecrets.operator }
    },
    workers: [{ id: "host-a", token: controlPlaneSecrets.host, slots: [{ id: "execution", runtime: "container", profile: {
      runnerBaseImage: `registry.example/runner@sha256:${"c".repeat(64)}`,
      jobBaseImage: `registry.example/job@sha256:${"d".repeat(64)}`,
      bounds: { cpu: "1", memoryBytes: "1073741824", pids: "256", wallClockSeconds: "60", outputBytes: "1048576" }
    } }] }]
  };
}

export type ControlPlaneFixture = {
  readonly configPath: string;
  readonly config: Readonly<Record<string, unknown>>;
  readonly paths: {
    readonly nativeConfig: string;
    readonly nativeReadiness: string;
    readonly executionConfig: string;
    readonly executionReadiness: string;
  };
};

export async function writeControlPlaneFixture(directory: string): Promise<ControlPlaneFixture> {
  await mkdir(directory, { recursive: true });
  const paths = {
    nativeConfig: join(directory, "native.json"),
    nativeReadiness: join(directory, "native-readiness.token"),
    executionConfig: join(directory, "execution.json"),
    executionReadiness: join(directory, "execution-readiness.token")
  } as const;
  await Promise.all([
    writePrivate(paths.nativeConfig, `${JSON.stringify(nativeServiceConfig())}\n`),
    writePrivate(paths.nativeReadiness, `${controlPlaneSecrets.nativeReadiness}\n`),
    writePrivate(paths.executionConfig, `${JSON.stringify(executionServiceConfig())}\n`),
    writePrivate(paths.executionReadiness, `${controlPlaneSecrets.executionReadiness}\n`)
  ]);
  const config = {
    schemaVersion: 1,
    deploymentId: "main",
    nativeGit: {
      image: `registry.example/dim/native-git@sha256:${"a".repeat(64)}`,
      configFile: paths.nativeConfig,
      readinessTokenFile: paths.nativeReadiness,
      publish: { host: "127.0.0.1", port: 7443 }
    },
    execution: {
      image: `registry.example/dim/execution@sha256:${"b".repeat(64)}`,
      configFile: paths.executionConfig,
      readinessTokenFile: paths.executionReadiness,
      publish: { host: "127.0.0.1", port: 7410 }
    }
  } as const;
  const configPath = join(directory, "install.json");
  await writePrivate(configPath, `${JSON.stringify(config)}\n`);
  return { configPath, config, paths };
}

export async function writePrivate(target: string, contents: string): Promise<void> {
  await writeFile(target, contents, { mode: 0o600 });
  await chmod(target, 0o600);
}
