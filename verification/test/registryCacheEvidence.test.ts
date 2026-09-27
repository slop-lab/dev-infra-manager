import { spawn, type ChildProcessByStdio } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import type { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";

const fixtureScript = resolve(import.meta.dirname, "../scripts/registry-cache-evidence.mjs");
const fixtureRoots: string[] = [];
type FixtureProcess = ChildProcessByStdio<null, Readable, Readable>;
const fixtureProcesses: FixtureProcess[] = [];

type Metadata = {
  readonly base_url: string;
  readonly config_digest: string;
  readonly evidence_file: string;
  readonly event_kind: string;
  readonly host: string;
  readonly manifest_digest: string;
  readonly port: number;
  readonly repository: string;
  readonly route: string;
  readonly run_id: string;
  readonly schema_version: number;
};

type HttpResult = {
  readonly body: Buffer;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly status: number;
};

type EvidenceRecord = {
  readonly event_kind: string;
  readonly method: string;
  readonly reference: string;
  readonly repository: string;
  readonly result: string;
  readonly route: string;
  readonly run_id: string;
  readonly sequence: number;
};

class FixtureStartupError extends Error {
  readonly name = "FixtureStartupError";
}

function parseMetadata(value: unknown): Metadata {
  return {
    base_url: stringField(value, "base_url"),
    config_digest: stringField(value, "config_digest"),
    evidence_file: stringField(value, "evidence_file"),
    event_kind: stringField(value, "event_kind"),
    host: stringField(value, "host"),
    manifest_digest: stringField(value, "manifest_digest"),
    port: numberField(value, "port"),
    repository: stringField(value, "repository"),
    route: stringField(value, "route"),
    run_id: stringField(value, "run_id"),
    schema_version: numberField(value, "schema_version")
  };
}

function parseEvidence(value: unknown): EvidenceRecord {
  return {
    event_kind: stringField(value, "event_kind"), method: stringField(value, "method"),
    reference: stringField(value, "reference"), repository: stringField(value, "repository"),
    result: stringField(value, "result"), route: stringField(value, "route"),
    run_id: stringField(value, "run_id"), sequence: numberField(value, "sequence")
  };
}

function stringField(value: unknown, key: string): string {
  if (typeof value === "object" && value !== null && key in value && typeof value[key] === "string") return value[key];
  throw new FixtureStartupError(`field ${key} is missing`);
}

function numberField(value: unknown, key: string): number {
  if (typeof value === "object" && value !== null && key in value && typeof value[key] === "number") return value[key];
  throw new FixtureStartupError(`field ${key} is missing`);
}

async function startFixture(
  runId = "Run / 42",
  route = "Fast Lane"
): Promise<{ readonly metadata: Metadata; readonly process: FixtureProcess }> {
  const root = await mkdtemp(resolve(tmpdir(), "dim-registry-evidence-"));
  fixtureRoots.push(root);
  const evidence = resolve(root, "requests.jsonl");
  const child = spawn(process.execPath, [
    fixtureScript,
    "--run-id", runId,
    "--route", route,
    "--evidence-file", evidence,
    "--port", "0"
  ], { stdio: ["ignore", "pipe", "pipe"] });
  fixtureProcesses.push(child);
  const lines = createInterface({ input: child.stdout });
  const stderr: Buffer[] = [];
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
  const line = await Promise.race([
    new Promise<string>((resolveLine) => lines.once("line", resolveLine)),
    new Promise<never>((_resolve, reject) => child.once("exit", (code) => {
      reject(new FixtureStartupError(`fixture exited ${code}: ${Buffer.concat(stderr).toString("utf8")}`));
    }))
  ]);
  lines.close();
  const parsed: unknown = JSON.parse(line);
  return { metadata: parseMetadata(parsed), process: child };
}

async function http(method: string, url: string): Promise<HttpResult> {
  return new Promise((resolveRequest, reject) => {
    const outgoing = request(url, { method }, (incoming) => {
      const chunks: Buffer[] = [];
      incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
      incoming.once("end", () => resolveRequest({
        body: Buffer.concat(chunks),
        headers: incoming.headers,
        status: incoming.statusCode ?? 0
      }));
    });
    outgoing.once("error", reject);
    outgoing.end();
  });
}

async function stopFixture(child: FixtureProcess): Promise<number | null> {
  const exited = new Promise<number | null>((resolveExit) => child.once("exit", resolveExit));
  child.kill("SIGTERM");
  return exited;
}

afterEach(async () => {
  await Promise.all(fixtureProcesses.splice(0).map(async (child) => {
    if (child.exitCode === null) await stopFixture(child);
  }));
  await Promise.all(fixtureRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("registry cache evidence fixture", () => {
  it("serves deterministic zero-layer image bytes by probe and immutable digest", async () => {
    // Given
    const fixture = await startFixture();
    const duplicate = await startFixture();
    const otherRoute = await startFixture("Run / 42", "Slow Lane");
    const manifestUrl = `${fixture.metadata.base_url}/v2/${fixture.metadata.repository}/manifests`;
    const expectedConfig = JSON.stringify({
      architecture: "amd64",
      config: { Labels: {
        "org.dev-infra-manager.cache-route": "fast-lane",
        "org.dev-infra-manager.run": "run-42"
      } },
      os: "linux",
      rootfs: { type: "layers", diff_ids: [] }
    });
    const expectedConfigDigest = `sha256:${createHash("sha256").update(expectedConfig).digest("hex")}`;
    const expectedManifest = JSON.stringify({
      schemaVersion: 2,
      mediaType: "application/vnd.docker.distribution.manifest.v2+json",
      config: {
        mediaType: "application/vnd.docker.container.image.v1+json",
        size: Buffer.byteLength(expectedConfig),
        digest: expectedConfigDigest
      },
      layers: []
    });

    // When
    const probe = await http("GET", `${manifestUrl}/probe`);
    const digest = await http("HEAD", `${manifestUrl}/${fixture.metadata.manifest_digest}`);
    const config = await http(
      "GET",
      `${fixture.metadata.base_url}/v2/${fixture.metadata.repository}/blobs/${fixture.metadata.config_digest}`
    );
    const configHead = await http(
      "HEAD",
      `${fixture.metadata.base_url}/v2/${fixture.metadata.repository}/blobs/${fixture.metadata.config_digest}`
    );

    // Then
    expect(fixture.metadata).toMatchObject({
      event_kind: "registry-cache-fixture-ready",
      host: "127.0.0.1",
      route: "fast-lane",
      run_id: "run-42",
      schema_version: 1
    });
    expect(duplicate.metadata.manifest_digest).toBe(fixture.metadata.manifest_digest);
    expect(duplicate.metadata.repository).toBe(fixture.metadata.repository);
    expect(otherRoute.metadata.repository).not.toBe(fixture.metadata.repository);
    expect(otherRoute.metadata.manifest_digest).not.toBe(fixture.metadata.manifest_digest);
    expect(probe.status).toBe(200);
    expect(probe.headers["content-type"]).toBe("application/vnd.docker.distribution.manifest.v2+json");
    expect(probe.headers["content-length"]).toBe(String(probe.body.length));
    expect(probe.headers["docker-content-digest"]).toBe(fixture.metadata.manifest_digest);
    expect(probe.body.toString("utf8")).toBe(expectedManifest);
    expect(`sha256:${createHash("sha256").update(probe.body).digest("hex")}`).toBe(fixture.metadata.manifest_digest);
    expect(digest.status).toBe(200);
    expect(digest.body).toHaveLength(0);
    expect(digest.headers["content-length"]).toBe(String(probe.body.length));
    expect(config.status).toBe(200);
    expect(config.headers["content-type"]).toBe("application/vnd.docker.container.image.v1+json");
    expect(config.headers["content-length"]).toBe(String(config.body.length));
    expect(config.headers["docker-content-digest"]).toBe(fixture.metadata.config_digest);
    expect(config.body.toString("utf8")).toBe(expectedConfig);
    expect(fixture.metadata.config_digest).toBe(expectedConfigDigest);
    expect(`sha256:${createHash("sha256").update(config.body).digest("hex")}`).toBe(fixture.metadata.config_digest);
    expect(configHead.status).toBe(200);
    expect(configHead.body).toHaveLength(0);
    expect(configHead.headers["content-length"]).toBe(String(config.body.length));
    expect(configHead.headers["docker-content-digest"]).toBe(fixture.metadata.config_digest);
  });

  it("implements the anonymous read-only Registry v2 error surface", async () => {
    // Given
    const { metadata } = await startFixture();
    const repositoryUrl = `${metadata.base_url}/v2/${metadata.repository}`;

    // When
    const [ping, pingHead, manifestMiss, blobMiss, upload, write] = await Promise.all([
      http("GET", `${metadata.base_url}/v2/`),
      http("HEAD", `${metadata.base_url}/v2/`),
      http("GET", `${repositoryUrl}/manifests/sha256:${"0".repeat(64)}`),
      http("GET", `${repositoryUrl}/blobs/sha256:${"1".repeat(64)}`),
      http("POST", `${repositoryUrl}/blobs/uploads/`),
      http("PUT", `${repositoryUrl}/manifests/probe`)
    ]);

    // Then
    expect(ping.status).toBe(200);
    expect(pingHead.status).toBe(200);
    expect(pingHead.body).toHaveLength(0);
    expect(JSON.parse(manifestMiss.body.toString("utf8"))).toMatchObject({
      errors: [{ code: "MANIFEST_UNKNOWN" }]
    });
    expect(manifestMiss.status).toBe(404);
    expect(blobMiss.status).toBe(404);
    expect(blobMiss.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(blobMiss.body.toString("utf8"))).toMatchObject({ errors: [{ code: "BLOB_UNKNOWN" }] });
    expect(upload.status).toBe(405);
    expect(upload.headers.allow).toBe("GET, HEAD");
    expect(JSON.parse(upload.body.toString("utf8"))).toMatchObject({ errors: [{ code: "UNSUPPORTED" }] });
    expect(write.status).toBe(405);
  });

  it("serializes concurrent request evidence and flushes it before clean shutdown", async () => {
    // Given
    const fixture = await startFixture();
    const manifest = `${fixture.metadata.base_url}/v2/${fixture.metadata.repository}/manifests/probe`;

    // When
    const responses = await Promise.all(Array.from({ length: 32 }, (_value, index) =>
      http(index % 2 === 0 ? "GET" : "HEAD", manifest)
    ));
    const exitCode = await stopFixture(fixture.process);
    const evidence = (await readFile(fixture.metadata.evidence_file, "utf8"))
      .trim().split("\n").map((line) => {
        const parsed: unknown = JSON.parse(line);
        return parseEvidence(parsed);
      });

    // Then
    expect(responses.every((response) => response.status === 200)).toBe(true);
    expect(exitCode).toBe(0);
    expect(evidence).toHaveLength(32);
    expect(evidence.map((record) => record.sequence)).toEqual(Array.from({ length: 32 }, (_value, index) => index + 1));
    expect(evidence.every((record) =>
      record.run_id === "run-42"
      && record.route === "fast-lane"
      && record.event_kind === "upstream-request"
      && record.repository === fixture.metadata.repository
      && record.reference === "probe"
      && record.result === "manifest"
    )).toBe(true);
  });
});
