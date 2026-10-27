import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createNativeGitProjectRegistrarClient,
  NativeGitProjectRegistrarRejectedError,
  NativeGitProjectRegistrarUncertainWriteError
} from "../../../../packages/host/plugins/native-git/src/nativeGitProjectRegistrarClient.js";

const generationId = "a".repeat(64);
const credential = { username: "project-registrar-a",
  password: Buffer.alloc(32, 72).toString("base64url") } as const;

afterEach(() => { vi.useRealTimers(); });

describe("native Git Project registrar diagnostics", () => {
  it("rejects a stale serving generation during read-only identity attestation before POST", async () => {
    const requests: string[] = [];
    const client = createNativeGitProjectRegistrarClient(connection(), {
      async request(input) {
        requests.push(`${input.method} ${input.path}`);
        return response({ ...identity(), generationId: "b".repeat(64) });
      }
    });

    await expect(client.prepare(preparation(), AbortSignal.timeout(5_000)))
      .rejects.toThrow(/identity does not match/);
    expect(requests).toEqual(["GET /v1/operator-project-registrar-identity"]);
  });

  it("uses the caller operation deadline instead of inventing a five-second preparation cause", async () => {
    vi.useFakeTimers();
    let finishPreparation: ((value: ReturnType<typeof response>) => void) | undefined;
    let preparationSignal: AbortSignal | undefined;
    const client = createNativeGitProjectRegistrarClient(connection(), {
      async request(input) {
        if (input.method === "GET") return response(identity());
        preparationSignal = input.signal;
        return new Promise((resolve) => { finishPreparation = resolve; });
      }
    });
    const controller = new AbortController();
    const preparing = client.prepare(preparation(), controller.signal);
    await vi.advanceTimersByTimeAsync(5_001);

    expect(preparationSignal?.aborted).toBe(false);
    if (finishPreparation === undefined) throw new Error("preparation request was not issued");
    finishPreparation(response({ schemaVersion: 1, generationId, hostId: "host-a",
      preparation: { ...preparation(), state: "repository-prepared" } }));
    await expect(preparing).resolves.toMatchObject({ generationId });
  });

  it("distinguishes a known rejection from transport loss after a possible write", async () => {
    const identityResponse = response(identity());
    const uncertain = createNativeGitProjectRegistrarClient(connection(), {
      async request(input) {
        if (input.method === "GET") return identityResponse;
        throw new Error("connection ended after request write");
      }
    });
    await expect(uncertain.prepare(preparation(), AbortSignal.timeout(20_000)))
      .rejects.toMatchObject({ name: "NativeGitProjectRegistrarUncertainWriteError", outcome: "uncertain-write" });
    await expect(uncertain.prepare(preparation(), AbortSignal.timeout(20_000)))
      .rejects.toBeInstanceOf(NativeGitProjectRegistrarUncertainWriteError);

    const rejected = createNativeGitProjectRegistrarClient(connection(), {
      async request(input) {
        if (input.method === "GET") return identityResponse;
        return { ...identityResponse, statusCode: 409 };
      }
    });
    await expect(rejected.prepare(preparation(), AbortSignal.timeout(20_000)))
      .rejects.toMatchObject({ name: "NativeGitProjectRegistrarRejectedError", outcome: "rejected", statusCode: 409 });
    await expect(rejected.prepare(preparation(), AbortSignal.timeout(20_000)))
      .rejects.toBeInstanceOf(NativeGitProjectRegistrarRejectedError);
  });

  it.each(["server-error", "malformed-ack", "mismatched-ack"] as const)("keeps a possible write uncertain after %s", async (failure) => {
    const client = createNativeGitProjectRegistrarClient(connection(), {
      async request(input) {
        if (input.method === "GET") return response(identity());
        if (failure === "server-error") return { ...response({}), statusCode: 503 };
        if (failure === "malformed-ack") return { ...response({}), body: Buffer.from("not-json") };
        return response({ schemaVersion: 1, generationId: "b".repeat(64), hostId: "host-a",
          preparation: { ...preparation(), state: "repository-prepared" } });
      }
    });
    await expect(client.prepare(preparation(), AbortSignal.timeout(20_000)))
      .rejects.toMatchObject({ name: "NativeGitProjectRegistrarUncertainWriteError", outcome: "uncertain-write" });
  });
});

function connection() {
  return { schemaVersion: 1, endpoint: "http://127.0.0.1:1", serviceId: "native-main",
    hostId: "host-a", generationId, credential } as const;
}

function identity() {
  return { schemaVersion: 1, serviceId: "native-main", role: "operator-project-registrar",
    hostId: "host-a", generationId } as const;
}

function preparation() {
  return { serviceId: "native-main", projectId: "project-a", repositoryId: "root" } as const;
}

function response(body: unknown) {
  return { statusCode: 200, contentType: "application/json", cacheControl: "no-store",
    body: Buffer.from(JSON.stringify(body)) } as const;
}
