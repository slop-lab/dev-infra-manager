import { scryptSync } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import {
  createWebServerFromConfigFile,
  type WebServer,
  type WebServerOptions
} from "../../packages/web/core/src/index.js";
import {
  readJsonObject,
  stringField,
  type JsonObject
} from "./httpFixture.js";

export const WEB_USERNAME = "local-operator";
export const WEB_PASSWORD = "local-operator-password";

export type WebFixtureOptions = {
  readonly accounts?: readonly string[];
  readonly operatorAccountId?: string;
  readonly defaultClock?: boolean;
  readonly secureOrigin?: boolean;
  readonly server?: WebServerOptions;
};

export type LoginInput = {
  readonly cookie?: string;
  readonly password?: string;
  readonly username?: string;
};

export type WebFixture = {
  readonly baseUrl: string;
  readonly origin: string;
  readonly configPath: string;
  readonly now: { value: number };
  readonly service: WebServer;
  login(input?: LoginInput): Promise<Response>;
  close(): Promise<void>;
};

export async function webFixture(options: WebFixtureOptions = {}): Promise<WebFixture> {
  const root = await mkdtemp(join(tmpdir(), "dim-web-"));
  const port = await availablePort();
  const origin = options.secureOrigin === true ? "https://console.example" : `http://127.0.0.1:${port}`;
  const configPath = join(root, "web.json");
  const config = webConfig({
    accounts: options.accounts ?? [WEB_USERNAME],
    publicOrigin: origin,
    port,
    operatorAccountId: options.operatorAccountId ?? options.accounts?.[0] ?? WEB_USERNAME
  });
  await writeFile(configPath, `${JSON.stringify(config)}\n`, { mode: 0o600 });
  await chmod(configPath, 0o600);
  const now = { value: 1_000_000 };
  const serviceOptions = options.defaultClock === true
    ? options.server ?? {}
    : { ...options.server, now: () => now.value };
  const service = await createWebServerFromConfigFile(configPath, serviceOptions);
  const baseUrl = await service.listen();
  return {
    baseUrl,
    origin,
    configPath,
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
      await rm(root, { recursive: true, force: true });
    }
  };
}

export function webConfig(input: {
  readonly accounts?: readonly string[];
  readonly publicOrigin: string;
  readonly port: number;
  readonly operatorAccountId?: string;
}): JsonObject {
  const salt = Buffer.from("0123456789abcdef", "utf8");
  const hash = scryptSync(WEB_PASSWORD, salt, 32, { N: 16_384, r: 8, p: 1 });
  return {
    schemaVersion: 1,
    host: "127.0.0.1",
    port: input.port,
    publicOrigin: input.publicOrigin,
    operations: { hosts: [], consoles: [] },
    accounts: (input.accounts ?? [WEB_USERNAME]).map((username) => ({
      username,
      roles: username === (input.operatorAccountId ?? WEB_USERNAME) ? ["read", "operator"] : ["read"],
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
