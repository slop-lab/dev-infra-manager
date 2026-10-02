import { describe, expect, it } from "vitest";
import { ingressPolicyRevision } from "../../plugin-external-urls/src/approvalPolicy.js";

const direct = {
  scheme: "http" as const,
  domain: "example.test",
  listenHost: "127.0.0.1",
  listenPort: 8080,
  approvalRequired: true
};

describe("external URL approval policy revision", () => {
  it("changes when a direct listener widens its stable external exposure", () => {
    expect(ingressPolicyRevision("public", direct)).not.toBe(ingressPolicyRevision("public", {
      ...direct,
      listenHost: "0.0.0.0"
    }));
  });

  it("ignores a managed Caddy router's ephemeral internal port", () => {
    const approvalExposure = { listenHost: "0.0.0.0", listenPort: 443 };
    expect(ingressPolicyRevision("public", {
      ...direct,
      scheme: "https",
      listenPort: 32001,
      approvalExposure
    })).toBe(ingressPolicyRevision("public", {
      ...direct,
      scheme: "https",
      listenPort: 32002,
      approvalExposure
    }));
  });
});
