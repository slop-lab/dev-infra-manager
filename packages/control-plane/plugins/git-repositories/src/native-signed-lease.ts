import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { NativeBasicCredential } from "./native-basic-auth.js";

const maximumPayloadBytes = 2048;

export function createNativeSignedLease(prefix: string, lifetimeMilliseconds: number, now: () => number) {
  let key = randomBytes(32);
  return {
    issue(scope: readonly string[]): NativeBasicCredential & { readonly issuedAt: number; readonly expiresAt: number } {
      const username = `${prefix}${randomBytes(18).toString("base64url")}`;
      const issuedAt = now(), expiresAt = issuedAt + lifetimeMilliseconds;
      const payload = Buffer.from(JSON.stringify([1, username, issuedAt, expiresAt, ...scope]), "utf8");
      if (payload.length > maximumPayloadBytes) throw new Error("native Git lease scope is too large");
      const mac = createHmac("sha256", key).update(payload).digest();
      return { username, password: Buffer.concat([payload, mac]).toString("base64url"), issuedAt, expiresAt };
    },
    authenticate(credential: NativeBasicCredential): readonly unknown[] | undefined {
      const encodedUsername = credential.username.slice(prefix.length);
      if (!credential.username.startsWith(prefix) || !/^[A-Za-z0-9_-]+$/.test(encodedUsername)
        || Buffer.from(encodedUsername, "base64url").length !== 18 || Buffer.from(encodedUsername, "base64url").toString("base64url") !== encodedUsername
        || credential.password.length > 2800 || !/^[A-Za-z0-9_-]+$/.test(credential.password)) return;
      const encoded = Buffer.from(credential.password, "base64url");
      if (encoded.toString("base64url") !== credential.password || encoded.length <= 32 || encoded.length > maximumPayloadBytes + 32) return;
      const payload = encoded.subarray(0, -32), supplied = encoded.subarray(-32);
      const expected = createHmac("sha256", key).update(payload).digest();
      if (!timingSafeEqual(supplied, expected)) return;
      let value: unknown;
      try { value = JSON.parse(payload.toString("utf8")); } catch { return; }
      if (!Array.isArray(value) || value.length < 5 || value[0] !== 1 || value[1] !== credential.username
        || !Number.isSafeInteger(value[2]) || !Number.isSafeInteger(value[3])) return;
      const issuedAt = Number(value[2]), expiresAt = Number(value[3]), current = now();
      if (expiresAt - issuedAt !== lifetimeMilliseconds || current < issuedAt || current >= expiresAt) return;
      return value.slice(4);
    },
    clear(): void { key = randomBytes(32); }
  };
}
