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
  nativeGitReviewFixture,
  readJsonObject,
  reviewPath,
  stringField,
  type JsonObject,
  type ReviewFixture
} from "../../native-git/test/nativeGitReviewHarness.js";

export const WEB_USERNAME = "local-reviewer";
export const WEB_PASSWORD = "local-reviewer-password";

export type WebFixtureOptions = {
  readonly accounts?: readonly string[];
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
  const native = await nativeGitReviewFixture();
  const created = await native.request("reviewer-a-user", "POST", reviewPath(), {
    protectedRef: "refs/heads/main",
    proposalRef: native.proposalRef
  });
  const reviewId = stringField(await readJsonObject(created), "reviewId");
  const root = await mkdtemp(join(tmpdir(), "dim-reviewer-web-"));
  const port = await availablePort();
  const origin = options.secureOrigin === true ? "https://reviewer.example" : `http://127.0.0.1:${port}`;
  const configPath = join(root, "reviewer-web.json");
  const config = webConfig({
    accounts: options.accounts ?? [WEB_USERNAME],
    nativeBaseUrl: native.baseUrl(),
    publicOrigin: origin,
    port
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
      username: "reviewer-a-user",
      password: "reviewer-a-secret",
      projectId: "project-a",
      repositoryIds: ["source"],
      reviewerId: "reviewer-a"
    },
    accounts: (input.accounts ?? [WEB_USERNAME]).map((username) => ({
      username,
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

async function availablePort(): Promise<number> {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("expected TCP address");
  server.close();
  await once(server, "close");
  return address.port;
}
