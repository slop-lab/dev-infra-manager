import { once } from "node:events";
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { isDeepStrictEqual } from "node:util";
import type {
  NativeAdmissionPolicy,
  NativeAttemptAssignment
} from "../../../../core/packages/core/src/nativeOrdinaryAuthorityModel.js";

export type ProofMode = "available" | "redirect" | "replay" | "timeout" | "wrong-role" | "wrong-service" | "wrong-scope";

type ProofRequest = {
  readonly endpoint: string;
  readonly method: "GET" | "POST";
  readonly path: string;
  readonly authorization: string;
  readonly body?: string;
  readonly signal: AbortSignal;
};

type ProofResponse = {
  readonly statusCode: number;
  readonly contentType: string | undefined;
  readonly cacheControl: string | undefined;
  readonly body: Buffer;
};

export const nativeGitIdentityCredential = {
  username: "ordinary-identity",
  password: "identity-secret-00000000000000000000"
} as const;

export type NativeGitAdmissionFixture = {
  readonly endpoint: string;
  readonly httpClient: { request(input: ProofRequest): Promise<ProofResponse> };
  authorizePolicy(requested: NativeAdmissionPolicy, canonical?: NativeAdmissionPolicy): void;
  authorizeAttempt(requested: NativeAttemptAssignment, canonical?: NativeAttemptAssignment): void;
  requestCount(): number;
  setMode(mode: ProofMode): void;
  close(): Promise<void>;
};

export async function startNativeGitAdmissionFixture(): Promise<NativeGitAdmissionFixture> {
  const policies = new Map<string, { readonly requested: NativeAdmissionPolicy; readonly canonical: NativeAdmissionPolicy }>();
  const attempts = new Map<string, { readonly requested: NativeAttemptAssignment; readonly canonical: NativeAttemptAssignment }>();
  let mode: ProofMode = "available";
  let requests = 0;
  const server = createServer((request, response) => {
    void serve(request, response);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("expected native proof TCP listener");
  const endpoint = `http://127.0.0.1:${address.port}`;

  return {
    endpoint,
    httpClient: {
      async request(input) {
        return nodeRequest(new URL(input.path, endpoint), input);
      }
    },
    authorizePolicy(requested, canonical = requested) {
      policies.set(`${requested.projectId}\0${requested.repositoryId}`, { requested, canonical });
    },
    authorizeAttempt(requested, canonical = requested) {
      attempts.set(requested.attemptId, { requested, canonical });
    },
    requestCount() {
      return requests;
    },
    setMode(value) {
      mode = value;
    },
    async close() {
      server.closeAllConnections();
      server.close();
      await once(server, "close");
    }
  };

  async function serve(request: IncomingMessage, response: ServerResponse): Promise<void> {
    requests += 1;
    if (mode === "timeout") return;
    if (mode === "redirect") {
      response.writeHead(302, { Location: "/v1/ordinary-authority/identity" }).end();
      return;
    }
    if (request.headers.authorization !== basicAuthorization(
      nativeGitIdentityCredential.username,
      nativeGitIdentityCredential.password
    )) {
      response.writeHead(401, { "Cache-Control": "no-store" }).end();
      return;
    }
    if (request.method === "GET" && request.url === "/v1/ordinary-authority/identity") {
      send(response, 200, {
        schemaVersion: 1,
        serviceId: mode === "wrong-service" ? "foreign-native" : "native-main",
        role: mode === "wrong-role" ? "native-query" : "ordinary-authority-reader",
        scope: mode === "wrong-scope" ? ["policy:read"] : ["policy:read", "attempt:read"]
      });
      return;
    }
    const match = /^\/v1\/projects\/([^/]+)\/repositories\/([^/]+)\/ordinary-authority\/(policy|current-attempt)$/.exec(request.url ?? "");
    if (request.method !== "POST" || match === null) {
      send(response, 404);
      return;
    }
    const projectId = match[1];
    const repositoryId = match[2];
    const kind = match[3];
    if (projectId === undefined || repositoryId === undefined || kind === undefined) {
      send(response, 404);
      return;
    }
    const body = await readJson(request);
    const requestId = body.requestId;
    if (typeof requestId !== "string") {
      send(response, 400);
      return;
    }
    if (kind === "policy") {
      const proof = policies.get(`${projectId}\0${repositoryId}`);
      if (proof === undefined || body.protectedRef !== proof.requested.protectedRef) {
        send(response, 404);
        return;
      }
      const { eligibleAssignments: _eligibleAssignments, ...policy } = proof.canonical;
      send(response, 200, {
        schemaVersion: 1,
        serviceId: "native-main",
        requestId: mode === "replay" ? "00000000-0000-4000-8000-000000000099" : requestId,
        policy
      });
      return;
    }
    const attemptId = body.attemptId;
    const proof = typeof attemptId === "string" ? attempts.get(attemptId) : undefined;
    if (proof === undefined || !isDeepStrictEqual(body, {
      schemaVersion: 1,
      requestId,
      reviewId: proof.requested.reviewId,
      jobName: proof.requested.descriptor.jobName,
      attemptId: proof.requested.attemptId
    })) {
      send(response, 404);
      return;
    }
    send(response, 200, {
      schemaVersion: 1,
      serviceId: "native-main",
      requestId: mode === "replay" ? "00000000-0000-4000-8000-000000000099" : requestId,
      assignment: proof.canonical
    });
  }
}

function nodeRequest(url: URL, input: ProofRequest): Promise<ProofResponse> {
  return new Promise((resolve, reject) => {
    const body = input.body === undefined ? undefined : Buffer.from(input.body, "utf8");
    const request = httpRequest(url, {
      method: input.method,
      signal: input.signal,
      headers: {
        Authorization: input.authorization,
        Accept: "application/json",
        ...(body === undefined ? {} : {
          "Content-Type": "application/json",
          "Content-Length": String(body.length)
        })
      }
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => resolve({
        statusCode: response.statusCode ?? 0,
        contentType: response.headers["content-type"],
        cacheControl: response.headers["cache-control"],
        body: Buffer.concat(chunks)
      }));
      response.on("error", reject);
    });
    request.on("error", reject);
    if (body !== undefined) request.write(body);
    request.end();
  });
}

async function readJson(request: IncomingMessage): Promise<Readonly<Record<string, unknown>>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value));
}

function send(response: ServerResponse, status: number, body?: unknown): void {
  const headers = body === undefined ? { "Cache-Control": "no-store" } : {
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8"
  };
  response.writeHead(status, headers).end(body === undefined ? undefined : `${JSON.stringify(body)}\n`);
}

function basicAuthorization(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`, "utf8").toString("base64")}`;
}
