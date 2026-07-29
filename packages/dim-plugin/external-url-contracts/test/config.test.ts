import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  emptyExternalUrlConfig,
  readExternalUrlConfig,
  validateExternalUrlConfig,
  writeExternalUrlConfig
} from "../src/index.js";

describe("external URL config", () => {
  const roots: string[] = [];
  afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

  it("round-trips provider and ingress configuration atomically", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "dim-external-config-"));
    roots.push(root);
    const env = { DIM_EXTERNAL_URL_CONFIG: path.join(root, "external-urls.json") };
    const config = emptyExternalUrlConfig();
    config.providers.cloudflare = {
      driver: "cloudflare",
      zone: "Example.COM",
      recordType: "A",
      target: "203.0.113.10",
      proxied: false,
      credentialEnv: "CF_API_TOKEN"
    };
    config.ingresses.public = {
      driver: "caddy",
      description: "Public HTTPS",
      scheme: "https",
      domain: "Dev.Example.COM",
      listenHost: "127.0.0.1",
      listenPort: 9080,
      upstreamMode: "container-ip",
      provider: "cloudflare"
    };
    await writeExternalUrlConfig(config, env);
    expect(await readExternalUrlConfig(env)).toMatchObject({
      providers: { cloudflare: { zone: "example.com" } },
      ingresses: { public: { domain: "dev.example.com" } }
    });
    expect(JSON.parse(await readFile(env.DIM_EXTERNAL_URL_CONFIG, "utf8"))).toMatchObject({ schemaVersion: 1 });
  });

  it("rejects a Caddy ingress without a configured provider", () => {
    expect(() => validateExternalUrlConfig({
      schemaVersion: 1,
      providers: {},
      ingresses: {
        public: {
          driver: "caddy",
          description: "Public",
          scheme: "https",
          domain: "dev.example.com",
          listenHost: "127.0.0.1",
          listenPort: 9080,
          upstreamMode: "container-ip",
          provider: "missing"
        }
      }
    })).toThrow(/unknown provider/);
  });
});
