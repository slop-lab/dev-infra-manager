import { once } from "node:events";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import {
  createNodeAdmissionVerifierHttpClient,
  type OrdinaryCiDependencyConfig
} from "../../../../core/packages/native-git/src/index.js";
import { parseJsonObject, type JsonObject } from "./nativeGitReviewHarness.js";

export const queryAuthorization = `Basic ${Buffer.from("native-main:query-credential-secret").toString("base64")}`;

type Mode = "correct" | "foreign-identity" | "wrong-scope" | "malformed" | "redirect"
  | "unauthorized" | "transport-failure" | "replay" | "timeout" | "revoked";

export type RecordedRequest = {
  readonly method: string;
  readonly path: string;
  readonly authorization: string | undefined;
  readonly body: string;
};

export type OrdinaryFixture = {
  mode: Mode;
  readonly requests: RecordedRequest[];
  readonly client: ReturnType<typeof createNodeAdmissionVerifierHttpClient>;
  close(): Promise<void>;
};

const fixtures: OrdinaryFixture[] = [];

export async function closeOrdinaryFixtures(): Promise<void> {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.close()));
}

export async function ordinaryFixture(): Promise<OrdinaryFixture> {
  const requests: RecordedRequest[] = [];
  const state: { mode: Mode; replay: JsonObject | undefined } = { mode: "correct", replay: undefined };
  const server = createServer((request, response) => void respond(state, requests, request, response));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("ordinary fixture requires a TCP listener");
  const fixture: OrdinaryFixture = {
    get mode() { return state.mode; },
    set mode(mode) { state.mode = mode; },
    requests,
    client: createNodeAdmissionVerifierHttpClient(`http://127.0.0.1:${address.port}`),
    async close() {
      server.close();
      await once(server, "close");
    }
  };
  fixtures.push(fixture);
  return fixture;
}

async function respond(
  state: { mode: Mode; replay: JsonObject | undefined },
  requests: RecordedRequest[],
  request: IncomingMessage,
  response: ServerResponse
): Promise<void> {
  const body = await readBody(request);
  requests.push({ method: request.method ?? "", path: request.url ?? "", authorization: request.headers.authorization, body });
  if (state.mode === "transport-failure") {
    request.socket.destroy();
    return;
  }
  if (state.mode === "timeout") return;
  if (state.mode === "redirect") return json(response, 307, { location: "/elsewhere" });
  if (state.mode === "unauthorized" || request.headers.authorization !== queryAuthorization) return json(response, 401, {});
  if (request.url === "/v1/identity") {
    if (state.mode === "malformed") return json(response, 200, { serviceId: "ordinary-main" });
    return json(response, 200, {
      schemaVersion: 1,
      serviceId: state.mode === "foreign-identity" ? "ordinary-foreign" : "ordinary-main",
      role: "native-query",
      scope: state.mode === "wrong-scope" ? ["admission:read"] : ["admission:read", "attempt:read"]
    });
  }
  if (state.mode === "revoked") return json(response, 409, {});
  const parsed = parseJsonObject(body);
  if (state.mode === "replay" && state.replay !== undefined) return json(response, 200, state.replay);
  if (state.mode === "malformed") return json(response, 200, { schemaVersion: 1, serviceId: "ordinary-main" });
  const result = { ...parsed, serviceId: "ordinary-main", authorized: true };
  state.replay = result;
  return json(response, 200, result);
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

function json(response: ServerResponse, status: number, body: JsonObject): void {
  response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  response.end(`${JSON.stringify(body)}\n`);
}

export function ordinaryConfig(): OrdinaryCiDependencyConfig {
  return {
    endpoint: "http://ordinary-ci:8080",
    serviceId: "ordinary-main",
    query: { username: "native-main", password: "query-credential-secret" },
    identity: { username: "ordinary-identity", password: "identity-credential-secret" },
    attemptIssuer: { username: "ordinary-attempts", password: "attempt-credential-secret" },
    resultReporter: { username: "ordinary-results", password: "reporter-credential-secret" }
  };
}

export function nativeConfigInput(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    host: "127.0.0.1",
    port: 0,
    storageRoot: "/tmp/native-git-config-test",
    gitExecutable: "/usr/bin/git",
    gitVersion: "2.43.0",
    repositories: [{ projectId: "project-a", repositoryId: "source" }],
    identities: [{
      role: "reader",
      username: "reader-a",
      password: "reader-native-secret",
      projectId: "project-a",
      repositoryIds: ["source"]
    }],
    ordinaryCi: ordinaryConfig()
  };
}

export function currentAttempt() {
  return {
    reviewId: "a".repeat(64),
    attemptId: "00000000-0000-4000-8000-000000000000",
    descriptorDigest: `sha256:${"a".repeat(64)}`,
    admissionGeneration: "generation-7",
    hostId: "host-a",
    capacity: "primary"
  };
}
