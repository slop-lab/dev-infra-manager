import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import type { NativeGitIdentity } from "./config.js";

type CredentialDigest = {
  readonly identity: NativeGitIdentity;
  readonly username: Buffer;
  readonly password: Buffer;
};

export type NativeGitAuthenticator = {
  authenticate(headers: IncomingHttpHeaders): NativeGitIdentity | undefined;
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

function matches(candidate: CredentialDigest, username: Buffer, password: Buffer): boolean {
  const usernameMatches = timingSafeEqual(candidate.username, username);
  const passwordMatches = timingSafeEqual(candidate.password, password);
  return usernameMatches && passwordMatches;
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
