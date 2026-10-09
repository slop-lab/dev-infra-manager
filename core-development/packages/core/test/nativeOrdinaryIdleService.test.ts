import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import { spawn, type ChildProcess } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ordinaryBundleConfig, ordinaryBundleSecrets } from "./nativeOrdinaryBundleConfigFixture.js";

const run = promisify(execFile);
const workspaceRoot = resolve(import.meta.dirname, "../../../..");
const packageRoot = join(workspaceRoot, "core/packages/core");
const fixtureProcess = join(import.meta.dirname, "fixtures/nativeOrdinaryIdleProcess.mjs");
const roots: string[] = [];
const children: ChildProcess[] = [];
const readinessToken = Buffer.alloc(32, 21).toString("base64url");
const activationToken = Buffer.alloc(32, 22).toString("base64url");
const rotatedActivationToken = Buffer.alloc(32, 23).toString("base64url");
const generation = "a".repeat(64);
const nextGeneration = "b".repeat(64);

beforeAll(async () => {
  await run("pnpm", ["run", "build"], { cwd: packageRoot });
});

afterAll(async () => {
  await Promise.all(children.splice(0).map(stopService));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("ordinary CI idle bundle service process", () => {
  it("reports authenticated local readiness before activation and denies the wrong token", async () => {
    // Given
    const service = await startService();

    // When
    const ready = await call(service.port, "GET", "/readyz", readinessToken);
    const denied = await call(service.port, "GET", "/readyz", ordinaryBundleSecrets.alternate);

    // Then
    expect(ready).toEqual({ status: 200, body: { status: "ready", schemaVersion: 1 } });
    expect(denied.status).toBe(404);
    expect(JSON.stringify(ready)).not.toContain(readinessToken);
  });

  it("exposes only query-authenticated identity while every business mutation remains unavailable", async () => {
    // Given
    const service = await startService();
    const config = ordinaryBundleConfig();
    const queryAuthorization = `Basic ${Buffer.from(`${config.credentials.query.username}:${config.credentials.query.password}`).toString("base64")}`;

    // When
    const identity = await call(service.port, "GET", "/v1/identity", queryAuthorization, undefined, true);
    const statuses = await Promise.all([
      "/v1/operator-admissions", "/v1/native-events", "/v1/claims",
      "/v1/admission-verifications", "/v1/current-attempt-verifications"
    ].map(async (path) => (await call(service.port, "POST", path, activationToken, {})).status));

    // Then
    expect(identity).toEqual({
      status: 200,
      body: { schemaVersion: 1, serviceId: "ordinary-main", role: "native-query", scope: ["admission:read", "attempt:read"] }
    });
    expect(statuses).toEqual([503, 503, 503, 503, 503]);
    expect(businessRowCount(service.stateDirectory)).toBe(0);
  });

  it("does not persist invalid generations or requests with the wrong activation token", async () => {
    // Given
    const service = await startService();

    // When
    const invalid = await call(service.port, "POST", "/v1/activation", activationToken, {
      schemaVersion: 1,
      generationId: "not-a-generation"
    });
    const denied = await call(service.port, "POST", "/v1/activation", ordinaryBundleSecrets.alternate, {
      schemaVersion: 1,
      generationId: generation
    });
    const wrongGeneration = await activate(service.port, nextGeneration);

    // Then
    expect(invalid.status).toBe(400);
    expect(denied.status).toBe(404);
    expect(wrongGeneration.status).toBe(409);
    expect(activationRows(service.stateDirectory)).toEqual([]);
  });

  it("remains ready after binding the published activation generation", async () => {
    // Given
    const service = await startService();
    await activate(service.port, generation);

    // When
    const ready = await call(service.port, "GET", "/readyz", readinessToken);

    // Then
    expect(ready).toEqual({ status: 200, body: { status: "ready", schemaVersion: 1 } });
  });

  it("binds each activation generation to exactly one token across update and rollback", async () => {
    // Given
    const service = await startService();

    // When
    const first = await activate(service.port, generation);
    const repeated = await activate(service.port, generation);
    const sameTokenDifferentGeneration = await activate(service.port, nextGeneration);
    await stopService(service.child);
    const rotated = await startService(service.root, rotatedActivationToken);
    const beforeConflict = activationRows(service.stateDirectory);
    const sameGenerationDifferentToken = await activate(rotated.port, generation, rotatedActivationToken);
    const afterConflict = activationRows(service.stateDirectory);
    const forward = await activate(rotated.port, nextGeneration, rotatedActivationToken);
    await stopService(rotated.child);
    const rolledBack = await startService(service.root, activationToken);
    const rollback = await activate(rolledBack.port, generation);
    const mutation = await call(rolledBack.port, "POST", "/v1/operator-admissions", activationToken, {});

    // Then
    expect([first.status, repeated.status, forward.status, rollback.status]).toEqual([200, 200, 200, 200]);
    expect([sameTokenDifferentGeneration.status, sameGenerationDifferentToken.status]).toEqual([409, 409]);
    expect(afterConflict).toEqual(beforeConflict);
    expect(mutation.status).toBe(503);
    expect(activationRows(service.stateDirectory)).toEqual([
      { generationId: generation, tokenSha256: tokenSha256(activationToken) },
      { generationId: nextGeneration, tokenSha256: tokenSha256(rotatedActivationToken) }
    ]);
    expect(JSON.stringify([sameGenerationDifferentToken, sameTokenDifferentGeneration])).not.toContain(activationToken);
    expect(JSON.stringify([sameGenerationDifferentToken, sameTokenDifferentGeneration])).not.toContain(rotatedActivationToken);
    expect(businessRowCount(service.stateDirectory)).toBe(0);
  });

  it("hides activation from a non-service-local peer before authorization and persistence", async () => {
    const service = await startService();

    const result = await call(service.port, "POST", "/v1/activation", activationToken, {
      schemaVersion: 1,
      generationId: generation
    }, false, "127.0.0.2");

    expect(result.status).toBe(404);
    expect(activationRows(service.stateDirectory)).toEqual([]);
  });
});

async function activate(port: number, generationId: string, token = activationToken): Promise<HttpResult> {
  return call(port, "POST", "/v1/activation", token, { schemaVersion: 1, generationId });
}

async function startService(existingRoot?: string, token = activationToken): Promise<ServiceProcess> {
  const root = existingRoot ?? await mkdtemp(join(tmpdir(), "dim-ordinary-idle-service-"));
  if (existingRoot === undefined) roots.push(root);
  const stateDirectory = join(root, "state");
  const configPath = join(root, "service.json");
  const readinessPath = join(root, "readiness.token");
  const activationPath = join(root, "activation.token");
  if (existingRoot === undefined) {
    await Promise.all([
      writeFile(configPath, `${JSON.stringify(ordinaryBundleConfig())}\n`, { mode: 0o444 }),
      writeFile(readinessPath, `${readinessToken}\n`, { mode: 0o444 }),
      writeFile(activationPath, `${token}\n`, { mode: 0o444 })
    ]);
  } else {
    await writeFile(activationPath, `${token}\n`);
  }
  const expectedGenerationId = token === rotatedActivationToken ? nextGeneration : generation;
  const child = spawn(process.execPath, [
    fixtureProcess, configPath, stateDirectory, readinessPath, activationPath, expectedGenerationId
  ], {
    stdio: ["ignore", "pipe", "pipe"]
  });
  children.push(child);
  const port = await processPort(child);
  return { root, stateDirectory, port, child };
}

async function processPort(child: ChildProcess): Promise<number> {
  const stdout = child.stdout;
  const stderr = child.stderr;
  if (stdout === null || stderr === null) throw new TypeError("idle process pipes are unavailable");
  return new Promise((resolvePort, rejectPort) => {
    let output = "";
    let errors = "";
    stderr.setEncoding("utf8").on("data", (chunk: string) => { errors += chunk; });
    stdout.setEncoding("utf8").on("data", (chunk: string) => {
      output += chunk;
      const newline = output.indexOf("\n");
      if (newline < 0) return;
      const parsed: unknown = JSON.parse(output.slice(0, newline));
      if (typeof parsed === "object" && parsed !== null && "port" in parsed && typeof parsed.port === "number") {
        resolvePort(parsed.port);
      } else rejectPort(new TypeError("idle process emitted an invalid listener address"));
    });
    child.once("exit", (code) => rejectPort(new Error(`idle process exited ${String(code)}: ${errors}`)));
    child.once("error", rejectPort);
  });
}

async function stopService(child: ChildProcess): Promise<void> {
  const index = children.indexOf(child);
  if (index >= 0) children.splice(index, 1);
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolveStop, rejectStop) => {
    child.once("exit", (code, signal) => code === 0 || signal === "SIGTERM"
      ? resolveStop()
      : rejectStop(new Error(`idle process stopped with ${String(code)} ${String(signal)}`)));
    child.once("error", rejectStop);
    child.kill("SIGTERM");
  });
}

async function call(
  port: number,
  method: "GET" | "POST",
  path: string,
  credential: string,
  body?: Readonly<Record<string, unknown>>,
  basic = false,
  localAddress?: string
): Promise<HttpResult> {
  const bytes = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
  return new Promise((resolveCall, rejectCall) => {
    const outgoing = request({
      host: "127.0.0.1",
      localAddress,
      port,
      method,
      path,
      headers: {
        authorization: basic ? credential : `Bearer ${credential}`,
        ...(bytes === undefined ? {} : { "content-type": "application/json", "content-length": bytes.length })
      }
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        resolveCall({ status: response.statusCode ?? 0, body: text === "" ? undefined : JSON.parse(text) });
      });
    });
    outgoing.once("error", rejectCall);
    if (bytes !== undefined) outgoing.write(bytes);
    outgoing.end();
  });
}

function activationRows(stateDirectory: string): readonly ActivationRow[] {
  const database = new DatabaseSync(join(stateDirectory, "ordinary-ci.sqlite3"), { readOnly: true });
  const rows = database.prepare(
    "SELECT generation_id, activation_token_sha256 FROM bundle_activation ORDER BY generation_id"
  ).all().map((row) => ({
    generationId: Reflect.get(row, "generation_id"),
    tokenSha256: Reflect.get(row, "activation_token_sha256")
  }));
  database.close();
  return rows.filter((row): row is ActivationRow => typeof row.generationId === "string" && typeof row.tokenSha256 === "string");
}

function tokenSha256(token: string): string {
  return createHash("sha256").update(Buffer.from(token, "base64url")).digest("hex");
}

function businessRowCount(stateDirectory: string): number {
  const database = new DatabaseSync(join(stateDirectory, "ordinary-ci.sqlite3"), { readOnly: true });
  const tables = [
    "native_root_admissions", "native_root_admission_requests", "native_root_ci_event_receipts"
  ] as const;
  const count = tables.reduce((total, table) => {
    const row = database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get();
    const value = row === undefined ? undefined : Reflect.get(row, "count");
    return total + (typeof value === "number" ? value : 0);
  }, 0);
  database.close();
  return count;
}

type ServiceProcess = {
  readonly root: string;
  readonly stateDirectory: string;
  readonly port: number;
  readonly child: ChildProcess;
};

type HttpResult = {
  readonly status: number;
  readonly body: unknown;
};

type ActivationRow = {
  readonly generationId: string;
  readonly tokenSha256: string;
};
