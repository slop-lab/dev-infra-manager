import { UserError } from "./errors.js";
import type { NativeGitAdmissionConfig } from "./nativeGitAdmissionSource.js";
import type { NativeGitResultReporterConfig } from "./nativeGitResultReporter.js";
import { resourceBounds, type NativeCapacityPolicy } from "./nativeOrdinaryAuthorityModel.js";

export type NativeOrdinaryCredential = {
  readonly username: string;
  readonly password: string;
};

export type NativeOrdinaryAuthorityConfig = {
  readonly schemaVersion: 4;
  readonly serviceId: string;
  readonly database: string;
  readonly admissionLeaseMilliseconds: number;
  readonly claimLeaseMilliseconds: number;
  readonly nativeGit: NativeGitAdmissionConfig & NativeGitResultReporterConfig;
  readonly credentials: {
    readonly webhook: NativeOrdinaryCredential;
    readonly registrar: NativeOrdinaryCredential;
    readonly query: NativeOrdinaryCredential;
  };
  readonly hosts: readonly {
    readonly hostId: string;
    readonly hostToken: string;
    readonly capacities: readonly {
      readonly capacity: string;
      readonly runnerBaseImage: string;
      readonly jobBaseImage: string;
      readonly bounds: NativeCapacityPolicy["bounds"];
    }[];
  }[];
};

export function validateNativeOrdinaryAuthorityConfig(
  config: NativeOrdinaryAuthorityConfig
): ReadonlyMap<string, NativeCapacityPolicy> {
  if (config.schemaVersion !== 4) throw new UserError("native ordinary authority schemaVersion must be 4");
  authorityIdentifier(config.serviceId, "service ID");
  if (config.database.length === 0) throw new UserError("native ordinary authority database path must not be empty");
  if (!Number.isSafeInteger(config.admissionLeaseMilliseconds) || config.admissionLeaseMilliseconds < 1) {
    throw new UserError("native ordinary authority admission lease must be positive");
  }
  if (!Number.isSafeInteger(config.claimLeaseMilliseconds) || config.claimLeaseMilliseconds < 1) {
    throw new UserError("native ordinary authority claim lease must be positive");
  }
  if (config.nativeGit.endpoint !== "http://native-git:8080" || config.nativeGit.serviceId !== "native-main") {
    throw new UserError("native ordinary authority native Git identity is invalid");
  }
  const credentials = [
    ...Object.values(config.credentials),
    config.nativeGit.identity,
    config.nativeGit.attemptIssuer,
    config.nativeGit.resultReporter
  ];
  for (const credential of credentials) {
    authorityIdentifier(credential.username, "credential username");
    if (!/^[A-Za-z0-9_-]{32,}$/.test(credential.password)) {
      throw new UserError("native ordinary authority passwords must be base64url and at least 32 characters");
    }
  }
  if (new Set(credentials.flatMap((credential) => [credential.username, credential.password])).size !== credentials.length * 2) {
    throw new UserError("native ordinary authority credentials must be distinct");
  }
  const capacities = new Map<string, NativeCapacityPolicy>();
  const hostTokens = new Set<string>();
  for (const host of config.hosts) {
    authorityIdentifier(host.hostId, "host ID");
    if (!/^[A-Za-z0-9_-]{32,}$/.test(host.hostToken)) {
      throw new UserError("native ordinary authority host tokens must be base64url and at least 32 characters");
    }
    if (hostTokens.has(host.hostToken) || credentials.some((credential) => credential.password === host.hostToken)) {
      throw new UserError("native ordinary authority credentials must be distinct");
    }
    hostTokens.add(host.hostToken);
    for (const capacity of host.capacities) {
      authorityIdentifier(capacity.capacity, "capacity");
      const key = `${host.hostId}\0${capacity.capacity}`;
      if (capacities.has(key)) throw new UserError("native ordinary authority capacities must be unique");
      if (!/^(?:(?:[a-z0-9]+(?:[.-][a-z0-9]+)*)(?::[0-9]+)?\/)?[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*@sha256:[0-9a-f]{64}$/.test(capacity.runnerBaseImage)) {
        throw new UserError("native ordinary authority runner base image is invalid");
      }
      if (!/^(?:(?:[a-z0-9]+(?:[.-][a-z0-9]+)*)(?::[0-9]+)?\/)?[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*@sha256:[0-9a-f]{64}$/.test(capacity.jobBaseImage)) {
        throw new UserError("native ordinary authority job base image is invalid");
      }
      capacities.set(key, {
        hostId: host.hostId,
        capacity: capacity.capacity,
        runnerBaseImage: capacity.runnerBaseImage,
        jobBaseImage: capacity.jobBaseImage,
        bounds: resourceBounds(capacity.bounds)
      });
    }
  }
  if (capacities.size === 0) throw new UserError("native ordinary authority requires at least one capacity");
  return capacities;
}

function authorityIdentifier(value: string, label: string): void {
  if (!/^[a-z0-9][a-z0-9._-]{0,127}$/.test(value)) throw new UserError(`${label} is invalid`);
}
