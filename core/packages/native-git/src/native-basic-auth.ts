import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

export type NativeBasicCredential = { readonly username: string; readonly password: string };

export function nativeBasicCredential(request: IncomingMessage): NativeBasicCredential | undefined {
  const header = request.headers.authorization;
  if (header === undefined || !header.startsWith("Basic ")) return undefined;
  const encoded = header.slice(6);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) return undefined;
  const decoded = Buffer.from(encoded, "base64");
  if (decoded.toString("base64") !== encoded) return undefined;
  const separator = decoded.indexOf(0x3a);
  if (separator < 1) return undefined;
  return {
    username: decoded.subarray(0, separator).toString("utf8"),
    password: decoded.subarray(separator + 1).toString("utf8")
  };
}

export function nativeBasicAuthorized(
  request: IncomingMessage,
  credential: NativeBasicCredential
): boolean {
  const supplied = Buffer.from(request.headers.authorization ?? "");
  const expected = Buffer.from(
    `Basic ${Buffer.from(`${credential.username}:${credential.password}`, "utf8").toString("base64")}`
  );
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}
