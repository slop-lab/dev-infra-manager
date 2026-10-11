import { afterEach, describe, expect, it, vi } from "vitest";
import { readJsonObject, stringField } from "../../native-git/test/nativeGitReviewHarness.js";
import {
  authenticatedSession,
  reviewerWebFixture,
  type WebFixture,
  type WebFixtureOptions
} from "./webHarness.js";

const fixtures: WebFixture[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.close()));
  vi.restoreAllMocks();
});

describe("DIM reviewer web session bounds", () => {
  it("rejects excess password derivations without queuing and preserves valid login", async () => {
    // Given
    const fixture = await startFixture({ server: { limits: { authenticationDerivations: 2 } } });

    // When
    const responses = await Promise.all(Array.from({ length: 24 }, () => fixture.login({ password: "wrong-password" })));

    // Then
    expect(responses.every(({ status }) => status === 401 || status === 429)).toBe(true);
    const busy = responses.filter(({ status }) => status === 429);
    expect(busy.length).toBeGreaterThan(0);
    expect(busy.every((response) => response.headers.get("retry-after") === "1")).toBe(true);
    expect(fixture.service.runtimeState().authentication.peakInFlight).toBe(2);
    fixture.now.value += 1_000;
    expect((await fixture.login()).status).toBe(201);
  });

  it("bounds paced sequential guesses and admits exactly one after refill", async () => {
    // Given
    const fixture = await startFixture();

    // When
    const burst = [];
    for (let attempt = 0; attempt < 8; attempt += 1) {
      burst.push(await fixture.login({ password: "wrong-password" }));
    }

    // Then
    expect(burst.map(({ status }) => status)).toEqual([401, 401, 401, 401, 401, 429, 429, 429]);
    expect(burst.slice(5).every((response) => response.headers.get("retry-after") === "1")).toBe(true);
    expect(fixture.service.runtimeState().authentication).toMatchObject({ derivations: 5, peakInFlight: 1 });

    fixture.now.value += 1_000;
    const admitted = await fixture.login({ password: "wrong-password" });
    const limited = await fixture.login({ password: "wrong-password" });
    expect(admitted.status).toBe(401);
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("1");
    expect(fixture.service.runtimeState().authentication.derivations).toBe(6);
  });

  it("performs one derivation for unknown and known-wrong accounts", async () => {
    // Given
    const fixture = await startFixture();
    const before = fixture.service.runtimeState().authentication.derivations;

    // When
    const [unknown, knownWrong] = await Promise.all([
      fixture.login({ username: "unknown-reviewer", password: "wrong-password" }),
      fixture.login({ password: "wrong-password" })
    ]);

    // Then
    expect(unknown.status).toBe(401);
    expect(knownWrong.status).toBe(401);
    expect(await readJsonObject(unknown)).toEqual(await readJsonObject(knownWrong));
    expect(fixture.service.runtimeState().authentication.derivations - before).toBe(2);
  });

  it("expires an absolute session after the wall clock rolls backward", async () => {
    // Given
    const clock = controlledPlatformClock();
    const fixture = await startFixture({ defaultClock: true });
    const session = await authenticatedSession(fixture);

    // When
    clock.wall -= 100_000;
    clock.wall += 30_001;
    clock.monotonic += 30_001;
    const response = await getSession(fixture, session.cookie);

    // Then
    expect(clock).toEqual({ monotonic: 30_001, wall: 930_001 });
    expect(response.status).toBe(401);
  });

  it("expires an idle session using monotonic progression", async () => {
    // Given
    const clock = controlledPlatformClock();
    const fixture = await startFixture({ defaultClock: true });
    const session = await authenticatedSession(fixture);

    // When
    clock.monotonic += 10_001;
    const response = await getSession(fixture, session.cookie);

    // Then
    expect(response.status).toBe(401);
  });

  it("expires an active session at its monotonic absolute deadline", async () => {
    // Given
    const clock = controlledPlatformClock();
    const fixture = await startFixture({ defaultClock: true });
    const session = await authenticatedSession(fixture);

    // When
    clock.monotonic += 9_000;
    const active = await getSession(fixture, session.cookie);
    clock.monotonic += 21_001;
    const expired = await getSession(fixture, session.cookie);

    // Then
    expect(active.status).toBe(200);
    expect(expired.status).toBe(401);
  });

  it("rotates every prior session for an account before logout", async () => {
    // Given
    const fixture = await startFixture();
    const first = await authenticatedSession(fixture);

    // When
    const secondResponse = await fixture.login({ cookie: first.cookie });

    // Then
    expect(secondResponse.status).toBe(201);
    expect(secondResponse.headers.get("set-cookie")).toMatch(/^dim_session=[A-Za-z0-9_-]+; Path=\/; HttpOnly; SameSite=Strict$/);
    const secondCookie = cookieFrom(secondResponse);
    const secondCsrf = stringField(await readJsonObject(secondResponse), "csrfToken");
    expect((await getSession(fixture, first.cookie)).status).toBe(401);
    expect((await getSession(fixture, secondCookie)).status).toBe(200);

    const logout = await fetch(`${fixture.baseUrl}/v1/session`, {
      method: "DELETE",
      headers: { Cookie: secondCookie, Origin: fixture.origin, "X-DIM-CSRF": secondCsrf }
    });
    expect(logout.status).toBe(204);
    expect((await getSession(fixture, first.cookie)).status).toBe(401);
    expect((await getSession(fixture, secondCookie)).status).toBe(401);
  });

  it("prunes expired orphan sessions before admitting a new session", async () => {
    // Given
    const fixture = await startFixture({
      accounts: ["reviewer-a", "reviewer-b", "reviewer-c"],
      server: { limits: { sessions: 2 } }
    });
    expect((await fixture.login({ username: "reviewer-a" })).status).toBe(201);
    expect((await fixture.login({ username: "reviewer-b" })).status).toBe(201);
    fixture.now.value += 30_001;

    // When
    const admitted = await fixture.login({ username: "reviewer-c" });

    // Then
    expect(admitted.status).toBe(201);
    expect(fixture.service.runtimeState().sessions).toBe(1);
  });

  it("rejects a valid login when the hard session cap is occupied", async () => {
    // Given
    const fixture = await startFixture({
      accounts: ["reviewer-a", "reviewer-b", "reviewer-c"],
      server: { limits: { sessions: 2 } }
    });
    const first = await fixture.login({ username: "reviewer-a" });
    const second = await fixture.login({ username: "reviewer-b" });

    // When
    const rejected = await fixture.login({ username: "reviewer-c" });

    // Then
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(rejected.status).toBe(429);
    expect(rejected.headers.get("retry-after")).toBe("1");
    expect(fixture.service.runtimeState().sessions).toBe(2);
  });
});

async function startFixture(options: WebFixtureOptions = {}): Promise<WebFixture> {
  const fixture = await reviewerWebFixture(options);
  fixtures.push(fixture);
  return fixture;
}

function cookieFrom(response: Response): string {
  const cookie = response.headers.get("set-cookie")?.split(";", 1)[0];
  if (cookie === undefined) throw new Error("expected session cookie");
  return cookie;
}

function getSession(fixture: WebFixture, cookie: string): Promise<Response> {
  return fetch(`${fixture.baseUrl}/v1/session`, { headers: { Cookie: cookie } });
}

function controlledPlatformClock(): { monotonic: number; wall: number } {
  const clock = { monotonic: 0, wall: 1_000_000 };
  vi.spyOn(performance, "now").mockImplementation(() => clock.monotonic);
  vi.spyOn(Date, "now").mockImplementation(() => clock.wall);
  return clock;
}
