import { afterEach, describe, expect, it } from "vitest";
import { readJsonObject, stringField } from "../../native-git/test/nativeGitReviewHarness.js";
import { reviewerWebFixture, type WebFixture } from "./webHarness.js";

const fixtures: WebFixture[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.close()));
});

describe("DIM reviewer web decision authorization", () => {
  it("binds native decision authority to one local account while other accounts remain read-only", async () => {
    // Given
    const fixture = await reviewerWebFixture({ accounts: ["alice", "bob"], reviewerAccountId: "alice" });
    fixtures.push(fixture);
    const alice = await sessionFor(fixture, "alice");
    const bob = await sessionFor(fixture, "bob");
    const memberPath = `${fixture.baseUrl}/v1/projects/project-a/repositories/source/reviews/${fixture.reviewId}`;
    const mutate = (session: AccountSession, suffix: string) => fetch(`${memberPath}/${suffix}`, {
      method: "POST",
      headers: {
        Cookie: session.cookie,
        "Content-Type": "application/json",
        Origin: fixture.origin,
        "X-DIM-CSRF": session.csrfToken
      },
      body: "{}"
    });

    // When
    const [aliceView, bobView] = await Promise.all([
      fetch(memberPath, { headers: { Cookie: alice.cookie } }),
      fetch(memberPath, { headers: { Cookie: bob.cookie } })
    ]);
    const bobApproval = await mutate(bob, "approvals");
    const aliceApproval = await mutate(alice, "approvals");
    const bobRevocation = await mutate(bob, "revocations");
    const aliceRevocation = await mutate(alice, "revocations");

    // Then
    expect(await readJsonObject(aliceView)).toMatchObject({ canDecide: true });
    expect(await readJsonObject(bobView)).toMatchObject({ canDecide: false });
    expect([bobApproval.status, aliceApproval.status, bobRevocation.status, aliceRevocation.status])
      .toEqual([403, 200, 403, 200]);
    expect(await readJsonObject(bobApproval)).toEqual({ error: "review action denied" });
    expect(await readJsonObject(bobRevocation)).toEqual({ error: "review action denied" });
  });
});

type AccountSession = { readonly cookie: string; readonly csrfToken: string };

async function sessionFor(fixture: WebFixture, username: string): Promise<AccountSession> {
  const response = await fixture.login({ username });
  const cookie = response.headers.get("set-cookie")?.split(";", 1)[0];
  if (cookie === undefined) throw new Error("expected session cookie");
  return { cookie, csrfToken: stringField(await readJsonObject(response), "csrfToken") };
}
