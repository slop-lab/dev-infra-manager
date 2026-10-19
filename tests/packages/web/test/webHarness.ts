import { scryptSync } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import {
  createReviewerWebServerFromConfigFile,
  type ReviewerWebServer,
  type ReviewerWebServerOptions
} from "../../../../core/packages/web/src/index.js";
import {
  readJsonObject,
  stringField,
  type JsonObject
} from "./httpFixture.js";

import { nativeBundleReviewFixture, createBundleReview, reviewProposalRef } from "../../native-git/test/nativeBundleReviewFixture.js";
import { humanReviewer, foreignHumanReviewer, generationId, generationB, activationTokenB, startFinalizeServiceForGeneration, activateFinalizeServiceForGeneration, runGit } from "../../native-git/test/nativeRootImportFinalizeFixture.js";
import { randomUUID } from "node:crypto";

export async function installedReviewerFixture() {
  const fixture = await nativeBundleReviewFixture("web");
  const envelope = await createBundleReview(fixture.service);
  let service = fixture.service;
  return {
    ...fixture, get service() { return service; }, reviewId: envelope.review.reviewId, proposalRef: reviewProposalRef,
    baseUrl: () => fixture.service.origin,
    git: (directory: string, args: string[]) => runGit("/usr/bin/git", ["-C", directory, ...args]),
    request: (username: string, method: string, path: string, body?: object) => {
      const credential = username === "docs-reviewer-user" ? foreignHumanReviewer : humanReviewer;
      return fetch(fixture.service.origin + path, { method, headers: {
        authorization: `Basic ${Buffer.from(`${credential.username}:${credential.password}`).toString("base64")}`,
        "Content-Type": "application/json", "X-Dim-Generation-Id": generationId
      }, ...(body === undefined ? {} : { body: JSON.stringify(path.endsWith("/approvals") ? { requestId: randomUUID() } : body) }) });
    },
    async restart() {
      const origin = fixture.service.origin;
      await service.close();
      service = await startFinalizeServiceForGeneration(fixture.root, generationB, activationTokenB);
      await activateFinalizeServiceForGeneration(service.origin, generationB, activationTokenB);
      await new Promise<void>((resolve) => service.server.close(() => resolve()));
      await new Promise<void>((resolve, reject) => {
        service.server.once("error", reject);
        service.server.listen(Number(new URL(origin).port), "127.0.0.1", () => { service.server.off("error", reject); resolve(); });
      });
    },
    async close() { await service.close(); await Promise.all([fixture.root, fixture.clone].map((root) => rm(root, { recursive:true, force:true }))); }
  };
}
export type ReviewFixture = Awaited<ReturnType<typeof installedReviewerFixture>>;

export const WEB_USERNAME = "local-reviewer";
export const WEB_PASSWORD = "local-reviewer-password";

export type WebFixtureOptions = {
  readonly accounts?: readonly string[];
  readonly reviewerAccountId?: string;
  readonly defaultClock?: boolean;
  readonly secureOrigin?: boolean;
  readonly server?: ReviewerWebServerOptions;
};

export type LoginInput = {
  readonly cookie?: string;
  readonly password?: string;
  readonly username?: string;
};

export type WebFixture = {
  readonly native: ReviewFixture;
  readonly baseUrl: string;
  readonly origin: string;
  readonly configPath: string;
  readonly reviewId: string;
  readonly now: { value: number };
  readonly service: ReviewerWebServer;
  login(input?: LoginInput): Promise<Response>;
  close(): Promise<void>;
};

export async function reviewerWebFixture(options: WebFixtureOptions = {}): Promise<WebFixture> {
  const native = await installedReviewerFixture();
  const reviewId = native.reviewId;
  const root = await mkdtemp(join(tmpdir(), "dim-web-"));
  const port = await availablePort();
  const origin = options.secureOrigin === true ? "https://reviewer.example" : `http://127.0.0.1:${port}`;
  const configPath = join(root, "reviewer-web.json");
  const config = webConfig({
    accounts: options.accounts ?? [WEB_USERNAME],
    nativeBaseUrl: native.baseUrl(),
    publicOrigin: origin,
    port,
    reviewerAccountId: options.reviewerAccountId ?? options.accounts?.[0] ?? WEB_USERNAME
  });
  await writeFile(configPath, `${JSON.stringify(config)}\n`, { mode: 0o600 });
  await chmod(configPath, 0o600);
  const now = { value: 1_000_000 };
  const serviceOptions = options.defaultClock === true
    ? options.server ?? {}
    : { ...options.server, now: () => now.value };
  const service = await createReviewerWebServerFromConfigFile(configPath, serviceOptions);
  const baseUrl = await service.listen();
  return {
    native,
    baseUrl,
    origin,
    configPath,
    reviewId,
    now,
    service,
    login: (input = {}) => fetch(`${baseUrl}/v1/session`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: origin,
        ...(input.cookie === undefined ? {} : { Cookie: input.cookie })
      },
      body: JSON.stringify({
        username: input.username ?? WEB_USERNAME,
        password: input.password ?? WEB_PASSWORD
      }),
      redirect: "manual"
    }),
    async close() {
      await service.close();
      await native.close();
      await rm(root, { recursive: true, force: true });
    }
  };
}

export function webConfig(input: {
  readonly accounts?: readonly string[];
  readonly nativeBaseUrl: string;
  readonly publicOrigin: string;
  readonly port: number;
  readonly reviewerAccountId?: string;
}): JsonObject {
  const salt = Buffer.from("0123456789abcdef", "utf8");
  const hash = scryptSync(WEB_PASSWORD, salt, 32, { N: 16_384, r: 8, p: 1 });
  return {
    schemaVersion: 1,
    host: "127.0.0.1",
    port: input.port,
    publicOrigin: input.publicOrigin,
    nativeGit: {
      baseUrl: input.nativeBaseUrl,
      username: humanReviewer.username,
      password: humanReviewer.password,
      projectId: "project-a",
      repositoryIds: ["root"],
      generationId,
      reviewerId: humanReviewer.reviewerId
    },
    accounts: (input.accounts ?? [WEB_USERNAME]).map((username) => ({
      username,
      roles: username === (input.reviewerAccountId ?? WEB_USERNAME) ? ["read", "reviewer"] : ["read"],
      passwordHash: `scrypt$16384$8$1$${salt.toString("base64")}$${hash.toString("base64")}`
    })),
    session: { idleSeconds: 10, absoluteSeconds: 30 }
  };
}

export async function authenticatedSession(fixture: WebFixture): Promise<{
  readonly cookie: string;
  readonly csrfToken: string;
}> {
  const response = await fixture.login();
  const cookie = response.headers.get("set-cookie")?.split(";", 1)[0];
  const body = await readJsonObject(response);
  if (cookie === undefined) throw new Error("expected session cookie");
  return { cookie, csrfToken: stringField(body, "csrfToken") };
}

export async function availablePort(): Promise<number> {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("expected TCP address");
  server.close();
  await once(server, "close");
  return address.port;
}
