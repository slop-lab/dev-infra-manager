import { once } from "node:events";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { applyRoutePolicy } from "../src/routePolicy.js";

describe("external URL route policies", () => {
  const cleanup: Array<() => Promise<void>> = [];
  afterEach(async () => Promise.all(cleanup.splice(0).map((item) => item())));

  it("allows only the authenticated workspace prefix by default", async () => {
    const request = {
      workspace: { id: "workspace-id", name: "work-1" },
      ingress: "public",
      requestedSubdomain: "work-1--docs",
      domain: "example.test"
    };
    await expect(applyRoutePolicy(undefined, request)).resolves.toBe("work-1--docs");
    await expect(applyRoutePolicy(undefined, {
      ...request,
      requestedSubdomain: "docs"
    })).rejects.toThrow("must start with 'work-1--'");
  });

  it("supports a fail-closed policy webhook over a Unix socket", async () => {
    const directory = await mkdtemp("/tmp/dim-route-policy-");
    cleanup.push(() => rm(directory, { recursive: true, force: true }));
    const socketPath = path.join(directory, "policy.sock");
    const server = http.createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      request.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { requestedSubdomain: string };
        response.setHeader("content-type", "application/json");
        if (body.requestedSubdomain === "large-response") {
          response.end(JSON.stringify({ allow: false, reason: "x".repeat(70_000) }));
          return;
        }
        response.end(JSON.stringify(
          body.requestedSubdomain === "docs"
            ? { allow: true, subdomain: "shared-docs" }
            : { allow: false, reason: "not approved" }
        ));
      });
    });
    server.listen(socketPath);
    await once(server, "listening");
    cleanup.push(() => new Promise((resolve) => server.close(() => resolve())));

    const policy = {
      driver: "webhook" as const,
      argument: JSON.stringify({ url: `unix:${socketPath}` })
    };
    const request = {
      workspace: { id: "workspace-id", name: "work-1" },
      ingress: "public",
      requestedSubdomain: "docs",
      domain: "example.test"
    };
    await expect(applyRoutePolicy(policy, request)).resolves.toBe("shared-docs");
    await expect(applyRoutePolicy(policy, {
      ...request,
      requestedSubdomain: "admin"
    })).rejects.toThrow("not approved");
    await expect(applyRoutePolicy(policy, {
      ...request,
      requestedSubdomain: "large-response"
    })).rejects.toThrow("exceeds 64 KiB");
  });

  it("runs the checked-in advanced route policy example", async () => {
    const directory = await mkdtemp("/tmp/dim-route-policy-example-");
    cleanup.push(() => rm(directory, { recursive: true, force: true }));
    const socketPath = path.join(directory, "policy.sock");
    const script = path.resolve(import.meta.dirname, "../../../../examples/external-url-route-policy/policy-server.mjs");
    const child = spawn(process.execPath, [script, socketPath], {
      stdio: ["ignore", "pipe", "inherit"]
    });
    await once(child.stdout, "data");
    cleanup.push(async () => {
      child.kill("SIGTERM");
      await once(child, "exit");
    });
    const policy = {
      driver: "webhook" as const,
      argument: JSON.stringify({ url: `unix:${socketPath}` })
    };
    const request = {
      workspace: { id: "workspace-id", name: "work-1" },
      ingress: "public",
      requestedSubdomain: "docs",
      domain: "example.test"
    };
    await expect(applyRoutePolicy(policy, request)).resolves.toBe("shared-docs");
    await expect(applyRoutePolicy(policy, {
      ...request,
      requestedSubdomain: "admin"
    })).rejects.toThrow("only the shared docs name is approved");
  });
});
