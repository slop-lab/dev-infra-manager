import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const token = (fill: number): string => Buffer.alloc(32, fill).toString("base64url");

export const controlPlaneSecrets = {
  query: token(1),
  identity: token(2),
  attemptIssuer: token(3),
  resultReporter: token(4),
  webhook: token(5),
  registrar: token(6),
  host: token(7),
  nativeReadiness: token(8),
  ordinaryReadiness: token(9),
  nativeActivation: token(10),
  ordinaryActivation: token(11),
  projectRegistrar: token(12),
  projectRootImporter: token(13),
  projectRootReadIssuer: token(14),
  workspaceWriteIssuer: token(15),
  humanReviewer: token(16)
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
    repositories: [],
    identities: [],
    projectRegistrars: [],
    projectRootImporters: [],
    projectRootReadIssuers: [],
    workspaceWriteIssuers: [],
    humanReviewers: [],
    ordinaryCi: {
      endpoint: "http://ordinary-ci:8080",
      serviceId: "ordinary-main",
      query: { username: "native-query", password: controlPlaneSecrets.query },
      identity: { username: "ordinary-identity", password: controlPlaneSecrets.identity },
      attemptIssuer: { username: "ordinary-attempts", password: controlPlaneSecrets.attemptIssuer },
      resultReporter: { username: "ordinary-results", password: controlPlaneSecrets.resultReporter },
      webhook: {
        endpoint: "http://ordinary-ci:8080/v1/native-events",
        username: "native-events",
        password: controlPlaneSecrets.webhook
      }
    }
  };
}

export function ordinaryServiceConfig(registrarPassword = controlPlaneSecrets.registrar): Readonly<Record<string, unknown>> {
  return {
    schemaVersion: 4,
    serviceId: "ordinary-main",
    database: "/var/lib/dim-ordinary-ci/ordinary-ci.sqlite3",
    admissionLeaseMilliseconds: 300_000,
    claimLeaseMilliseconds: 60_000,
    nativeGit: {
      endpoint: "http://native-git:8080",
      serviceId: "native-main",
      identity: { username: "ordinary-identity", password: controlPlaneSecrets.identity },
      attemptIssuer: { username: "ordinary-attempts", password: controlPlaneSecrets.attemptIssuer },
      resultReporter: { username: "ordinary-results", password: controlPlaneSecrets.resultReporter }
    },
    credentials: {
      webhook: { username: "native-events", password: controlPlaneSecrets.webhook },
      registrar: { username: "ordinary-registrar", password: registrarPassword },
      query: { username: "native-query", password: controlPlaneSecrets.query }
    },
    hosts: [{ hostId: "host-a", hostToken: controlPlaneSecrets.host, capacities: [] }]
  };
}

export type ControlPlaneFixture = {
  readonly configPath: string;
  readonly config: Readonly<Record<string, unknown>>;
  readonly paths: {
    readonly nativeConfig: string;
    readonly nativeReadiness: string;
    readonly ordinaryConfig: string;
    readonly ordinaryReadiness: string;
  };
};

export async function writeControlPlaneFixture(directory: string): Promise<ControlPlaneFixture> {
  await mkdir(directory, { recursive: true });
  const paths = {
    nativeConfig: join(directory, "native.json"),
    nativeReadiness: join(directory, "native-readiness.token"),
    ordinaryConfig: join(directory, "ordinary.json"),
    ordinaryReadiness: join(directory, "ordinary-readiness.token")
  } as const;
  await Promise.all([
    writePrivate(paths.nativeConfig, `${JSON.stringify(nativeServiceConfig())}\n`),
    writePrivate(paths.nativeReadiness, `${controlPlaneSecrets.nativeReadiness}\n`),
    writePrivate(paths.ordinaryConfig, `${JSON.stringify(ordinaryServiceConfig())}\n`),
    writePrivate(paths.ordinaryReadiness, `${controlPlaneSecrets.ordinaryReadiness}\n`)
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
    ordinaryCi: {
      image: `registry.example/dim/ordinary-ci@sha256:${"b".repeat(64)}`,
      configFile: paths.ordinaryConfig,
      readinessTokenFile: paths.ordinaryReadiness,
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
