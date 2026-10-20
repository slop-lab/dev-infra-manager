import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { NativeGitBundleHttpError, readBoundedJson, sendJson, sendNotFound } from "./native-bundle-http.js";
import {
  NativeProjectRegistrationConflictError,
  NativeProjectRegistrationHostMismatchError,
  NativeProjectRegistrationStateError
} from "./native-project-registry-state.js";
import {
  NativeGitProjectRegistrationError,
  parseNativeProjectPreparationInput,
  type NativeGitProjectPreparationResult,
  type NativeProjectPreparationInput
} from "./native-project-registration.js";

const hostId = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,127}$/);
const username = z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,62}[A-Za-z0-9])?$/);
const password = z.string().regex(/^[A-Za-z0-9_-]+$/).refine((value) => {
  const decoded = Buffer.from(value, "base64url");
  return decoded.length === 32 && decoded.toString("base64url") === value;
});
const registrarSchema = z.object({ hostId, username, password }).strict().readonly();

export type NativeGitProjectRegistrar = z.infer<typeof registrarSchema>;

type RegistrarRequest = {
  readonly generationId: string;
  readonly preparation: NativeProjectPreparationInput;
};

type RegistrarHttpContext = {
  readonly request: IncomingMessage;
  readonly response: ServerResponse;
  readonly pathname: string;
  readonly activated: boolean;
  readonly expectedGenerationId: string;
  readonly registrars: readonly NativeGitProjectRegistrar[];
  readonly knownCredentials: readonly { readonly username: string; readonly password: string }[];
  readonly prepareProject: (
    generationId: string, ownerHostId: string, input: NativeProjectPreparationInput
  ) => Promise<NativeGitProjectPreparationResult>;
};

export function parseNativeGitProjectRegistrars(input: unknown): readonly NativeGitProjectRegistrar[] {
  const result = z.array(registrarSchema).readonly().safeParse(input);
  if (!result.success) throw new NativeGitProjectRegistrarError("native Git Project registrars are invalid", { cause: result.error });
  const values = result.data.flatMap((registrar) => [registrar.hostId, registrar.username, registrar.password]);
  if (new Set(values).size !== values.length) {
    throw new NativeGitProjectRegistrarError("native Git Project registrar identities and credentials must be distinct");
  }
  return result.data;
}

export async function handleNativeGitProjectRegistrarHttp(context: RegistrarHttpContext): Promise<boolean> {
  const identityRequest = context.request.method === "GET"
    && context.pathname === "/v1/operator-project-registrar-identity";
  const preparationRequest = context.request.method === "POST"
    && context.pathname === "/v1/operator-project-preparations";
  if (!identityRequest && !preparationRequest) return false;
  if (context.registrars.length === 0) {
    sendNotFound(context.response);
    return true;
  }
  if (preparationRequest && !context.activated) {
    sendJson(context.response, 503, { error: "native Git business operations require exact generation activation" });
    return true;
  }
  const registrar = context.registrars.find((candidate) => basicAuthorized(context.request, candidate));
  if (registrar === undefined) {
    const known = context.knownCredentials.some((credential) => basicAuthorized(context.request, credential));
    sendJson(context.response, known ? 403 : 401, { error: known ? "forbidden" : "unauthorized" });
    return true;
  }
  if (identityRequest) {
    sendJson(context.response, 200, {
      schemaVersion: 1, serviceId: "native-main", role: "operator-project-registrar", hostId: registrar.hostId
    });
    return true;
  }
  try {
    const input = parseRegistrarRequest(await readBoundedJson(context.request));
    if (input.generationId !== context.expectedGenerationId) {
      sendJson(context.response, 409, { error: "native Git preparation generation conflicts with service startup" });
      return true;
    }
    const preparation = await context.prepareProject(input.generationId, registrar.hostId, input.preparation);
    sendJson(context.response, 200, {
      schemaVersion: 1,
      generationId: input.generationId,
      hostId: registrar.hostId,
      preparation
    });
  } catch (error) {
    if (error instanceof NativeProjectRegistrationHostMismatchError) {
      sendNotFound(context.response);
      return true;
    }
    if (error instanceof NativeProjectRegistrationConflictError) {
      sendJson(context.response, 409, { error: "native Project preparation conflicts" });
      return true;
    }
    if (error instanceof NativeGitBundleHttpError || error instanceof NativeProjectRegistrationStateError
      || error instanceof NativeGitProjectRegistrationError
      || error instanceof NativeGitProjectRegistrarRequestError) {
      sendJson(context.response, 400, { error: "native Project preparation request is invalid" });
      return true;
    }
    throw error;
  }
  return true;
}

function parseRegistrarRequest(value: unknown): RegistrarRequest {
  if (!isRecord(value) || !exactKeys(value, ["schemaVersion", "generationId", "preparation"])
    || value.schemaVersion !== 1 || typeof value.generationId !== "string"
    || !/^[0-9a-f]{64}$/.test(value.generationId)) {
    throw new NativeGitProjectRegistrarRequestError();
  }
  const preparation = parseNativeProjectPreparationInput(value.preparation);
  return { generationId: value.generationId, preparation };
}

function basicAuthorized(
  request: IncomingMessage,
  credential: { readonly username: string; readonly password: string }
): boolean {
  const supplied = Buffer.from(request.headers.authorization ?? "");
  const expected = Buffer.from(`Basic ${Buffer.from(`${credential.username}:${credential.password}`, "utf8").toString("base64")}`);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Readonly<Record<string, unknown>>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}

export class NativeGitProjectRegistrarError extends Error {
  readonly name = "NativeGitProjectRegistrarError";
}

class NativeGitProjectRegistrarRequestError extends Error {
  readonly name = "NativeGitProjectRegistrarRequestError";
}
