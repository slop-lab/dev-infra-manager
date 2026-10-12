import { describe, expect, it } from "vitest";
import { parseNativeQemuSchedulerConfig } from "../../../../core/packages/core/src/nativeQemuSchedulerConfig.js";

const token = (character: string): string => Buffer.alloc(32, character).toString("base64url");
const image = (name: string, character: string): string => `${name}@sha256:${character.repeat(64)}`;

function config(): unknown {
  return {
    schemaVersion: 2,
    serviceId: "qemu-main",
    host: "127.0.0.1",
    port: 9082,
    database: "/var/lib/dim-native-qemu/qemu.sqlite3",
    eligibilityLeaseMilliseconds: 120_000,
    claimLeaseMilliseconds: 60_000,
    nativeGit: {
      endpoint: "http://127.0.0.1:9080",
      serviceId: "native-main",
      identity: { username: "qemu-identity", password: token("a") },
      attemptIssuer: { username: "qemu-attempts", password: token("b") },
      candidateReader: { username: "qemu-candidate-reader", password: token("h") },
      resultReporter: { username: "qemu-results", password: token("c") }
    },
    credentials: {
      eventIntake: { username: "qemu-events", password: token("d") },
      query: { username: "qemu-query", password: token("f") }
    },
    hosts: [{
      hostId: "node-a",
      hostToken: token("g"),
      capacities: [{ capacity: "kvm-1", runnerBaseImage: image("example/runner", "1"),
        jobBaseImage: image("example/job", "2"), bounds: { cpu: "2", memoryBytes: "2147483648",
          pids: "512", wallClockSeconds: "900", outputBytes: "1048576" } }]
    }]
  };
}

describe("native QEMU scheduler config", () => {
  it("parses fixed operator hosts and capacities", () => {
    const parsed = parseNativeQemuSchedulerConfig(config());
    expect(parsed.hosts[0]?.capacities[0]?.capacity).toBe("kvm-1");
    expect(parsed.claimLeaseMilliseconds).toBe(60_000);
    expect(parsed.eligibilityLeaseMilliseconds).toBe(120_000);
  });

  it("rejects the predecessor schema without accepting its registrar credential", () => {
    const value = config();
    if (typeof value !== "object" || value === null) throw new TypeError("fixture");
    Reflect.set(value, "schemaVersion", 1);
    Reflect.set(value, "admissionLeaseMilliseconds", Reflect.get(value, "eligibilityLeaseMilliseconds"));
    Reflect.deleteProperty(value, "eligibilityLeaseMilliseconds");
    const credentials = Reflect.get(value, "credentials");
    if (typeof credentials !== "object" || credentials === null) throw new TypeError("fixture");
    Reflect.set(credentials, "registrar", { username: "qemu-registrar", password: token("e") });
    expect(() => parseNativeQemuSchedulerConfig(value)).toThrow(/configuration/i);
  });

  it("rejects a claim lease shorter than sixty seconds", () => {
    const value = config();
    if (typeof value !== "object" || value === null) throw new TypeError("fixture");
    Reflect.set(value, "claimLeaseMilliseconds", 59_999);
    expect(() => parseNativeQemuSchedulerConfig(value)).toThrow(/claim lease/i);
  });

  it("rejects reused authority values", () => {
    const value = config();
    if (typeof value !== "object" || value === null) throw new TypeError("fixture");
    const nativeGit = Reflect.get(value, "nativeGit");
    const credentials = Reflect.get(value, "credentials");
    if (typeof nativeGit !== "object" || nativeGit === null || typeof credentials !== "object" || credentials === null) {
      throw new TypeError("fixture");
    }
    Reflect.set(credentials, "query", Reflect.get(nativeGit, "identity"));
    expect(() => parseNativeQemuSchedulerConfig(value)).toThrow(/distinct/i);
  });
});
