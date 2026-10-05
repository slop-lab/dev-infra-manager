import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import type { NativeGitIdentity, OrdinaryCiDependencyConfig } from "./config.js";

type CredentialDigest = {
  readonly identity: NativeGitIdentity;
  readonly username: Buffer;
  readonly password: Buffer;
};

export type OrdinaryCiAttemptIssuerPrincipal = {
  readonly kind: "ordinary-ci-service";
  readonly role: "attempt-issuer";
  readonly username: string;
};

export type OrdinaryCiResultReporterPrincipal = {
  readonly kind: "ordinary-ci-service";
  readonly role: "result-reporter";
  readonly username: string;
};

export type OrdinaryCiServicePrincipal = OrdinaryCiAttemptIssuerPrincipal | OrdinaryCiResultReporterPrincipal;

type ServiceCredentialDigest = {
  readonly principal: OrdinaryCiServicePrincipal;
  readonly username: Buffer;
  readonly password: Buffer;
};

export type NativeGitAuthenticator = {
  authenticate(headers: IncomingHttpHeaders): NativeGitIdentity | undefined;
};

export type OrdinaryAuthorityAuthenticator = {
  authenticate(headers: IncomingHttpHeaders): boolean;
};

export type OrdinaryCiServiceAuthenticator = {
  authenticate(headers: IncomingHttpHeaders): OrdinaryCiServicePrincipal | undefined;
};

export function nativeGitAuthenticator(identities: readonly NativeGitIdentity[]): NativeGitAuthenticator {
  const credentials = identities.map((identity) => ({
    identity,
    username: digest(identity.username),
    password: digest(identity.password)
  }));
  return {
    authenticate(headers) {
      const parsed = basicCredential(headers.authorization);
      if (parsed === undefined) return undefined;
      const usernameDigest = digest(parsed.username);
      const passwordDigest = digest(parsed.password);
      return credentials.find((candidate) => matches(candidate, usernameDigest, passwordDigest))?.identity;
    }
  };
}

export function ordinaryAuthorityAuthenticator(
  credential: OrdinaryCiDependencyConfig["identity"]
): OrdinaryAuthorityAuthenticator {
  const expected = {
    username: digest(credential.username),
    password: digest(credential.password)
  };
  return {
    authenticate(headers) {
      const parsed = basicCredential(headers.authorization);
      if (parsed === undefined) return false;
      const usernameMatches = timingSafeEqual(expected.username, digest(parsed.username));
      const passwordMatches = timingSafeEqual(expected.password, digest(parsed.password));
      return usernameMatches && passwordMatches;
    }
  };
}

export function ordinaryCiServiceAuthenticator(
  config: OrdinaryCiDependencyConfig
): OrdinaryCiServiceAuthenticator {
  const credentials: readonly ServiceCredentialDigest[] = [
    serviceCredential("attempt-issuer", config.attemptIssuer),
    serviceCredential("result-reporter", config.resultReporter)
  ];
  return {
    authenticate(headers) {
      const parsed = basicCredential(headers.authorization);
      if (parsed === undefined) return undefined;
      const usernameDigest = digest(parsed.username);
      const passwordDigest = digest(parsed.password);
      return credentials.find((candidate) => matches(candidate, usernameDigest, passwordDigest))?.principal;
    }
  };
}

function matches(candidate: { readonly username: Buffer; readonly password: Buffer }, username: Buffer, password: Buffer): boolean {
  const usernameMatches = timingSafeEqual(candidate.username, username);
  const passwordMatches = timingSafeEqual(candidate.password, password);
  return usernameMatches && passwordMatches;
}

function serviceCredential(
  role: OrdinaryCiServicePrincipal["role"],
  credential: OrdinaryCiDependencyConfig["attemptIssuer"]
): ServiceCredentialDigest {
  return {
    principal: { kind: "ordinary-ci-service", role, username: credential.username },
    username: digest(credential.username),
    password: digest(credential.password)
  };
}

function basicCredential(header: string | undefined): { readonly username: string; readonly password: string } | undefined {
  if (header === undefined || !header.startsWith("Basic ")) return undefined;
  const encoded = header.slice(6);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) return undefined;
  const decoded = Buffer.from(encoded, "base64");
  if (decoded.toString("base64") !== encoded) return undefined;
  const separator = decoded.indexOf(0x3a);
  if (separator < 1) return undefined;
  const username = decoded.subarray(0, separator).toString("utf8");
  const password = decoded.subarray(separator + 1).toString("utf8");
  if (Buffer.from(`${username}:${password}`, "utf8").compare(decoded) !== 0) return undefined;
  return { username, password };
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}
