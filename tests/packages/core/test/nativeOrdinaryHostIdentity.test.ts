import { afterEach, describe, expect, it } from "vitest";
import {
  authorityCredentials,
  authorityHostCredentials,
  startAuthority,
  type AuthorityFixture
} from "./nativeOrdinaryAuthorityFixture.js";

const fixtures: AuthorityFixture[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map(async (fixture) => {
    await fixture.close();
    await fixture.remove();
  }));
});

describe("native ordinary host identity", () => {
  it("attests only the authenticated host role and service identity", async () => {
    // Given
    const fixture = await startAuthority();
    fixtures.push(fixture);
    const credential = authorityHostCredentials["host-a"];

    // When
    const response = await fetch(`${fixture.endpoint}/v1/host-identity`, {
      headers: {
        Authorization: `Basic ${Buffer.from(`${credential.username}:${credential.password}`, "utf8").toString("base64")}`
      }
    });

    // Then
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      schemaVersion: 1,
      serviceId: "ordinary-main",
      role: "native-host",
      hostId: "host-a"
    });
  });

  it("rejects role crossover without exposing host inventory", async () => {
    // Given
    const fixture = await startAuthority();
    fixtures.push(fixture);
    const query = authorityCredentials.query;

    // When
    const wrongRole = await fetch(`${fixture.endpoint}/v1/host-identity`, {
      headers: {
        Authorization: `Basic ${Buffer.from(`${query.username}:${query.password}`, "utf8").toString("base64")}`
      }
    });
    const unknown = await fetch(`${fixture.endpoint}/v1/host-identity`, {
      headers: { Authorization: "Basic invalid" }
    });

    // Then
    expect(wrongRole.status).toBe(403);
    expect(unknown.status).toBe(401);
    expect(await wrongRole.json()).toEqual({ error: "forbidden" });
    expect(await unknown.json()).toEqual({ error: "unauthorized" });
  });
});
