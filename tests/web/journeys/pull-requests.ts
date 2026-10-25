import type { JourneyContext } from "./support/context.js";
import { createReviewEnvironment, type ReviewEnvironment } from "./native-git/environment.js";
import { PullRequestUI } from "./native-git/pull-request-ui.js";

/** Assert user outcomes against disposable production services. DOM details live in the UI adapter. */
export async function runPullRequestJourney(context: JourneyContext, createEnvironment: () => Promise<ReviewEnvironment> = createReviewEnvironment, refreshBeforeResponse = false) {
  const environment = await context.step("prepare disposable pull request services", createEnvironment);
  context.cleanup(environment.close);
  const ui = new PullRequestUI(context.page);
  await context.step("sign in and create a managed project", async () => {
    await ui.signIn(environment.origin, environment.username, environment.password);
    await ui.openReviews(); await ui.createProject(environment.projectId);
  });
  await context.step("import the project repository through the UI", async () => {
    await ui.importRepository(environment.repositoryId, environment.upstreamUrl);
    await environment.assertProjectImported();
  });
  const proposal = await context.step("push a workspace proposal requiring review", environment.prepareProposal);
  await context.step("verify ordinary source push kept the protected ref", () => environment.assertProtectedHead(proposal.baseCommit));
  await context.step("discover and grant the browser reviewer role", async () => {
    await ui.openPendingProposal(proposal.proposalRef);
    await ui.expectReviewerAccessRequired();
    await ui.grantOwnReviewerRole(environment.username, environment.password);
    await ui.signIn(environment.origin, environment.username, environment.password);
    await ui.openReviews(environment.projectId, environment.repositoryId);
  });
  const title = "Review workspace configuration";
  await context.step("create a pull request and inspect its exact diff", () => ui.createPullRequest(proposal.proposalRef, title));
  await context.step("discuss the pull request", () => ui.postComment("Check the configuration boundary before merge."));
  await context.step("comment on an exact changed line", () => ui.postComment("This field change needs the reviewer policy.", true));
  await context.step("inspect independent line attribution", () => ui.inspectLineAttribution());
  await context.step("prepare and approve the first immutable revision", () => ui.approveRevision());
  await context.step("verify approval did not move the protected ref", () => environment.assertProtectedHead(proposal.baseCommit));
  await context.step("revoke the first revision approval", () => ui.revokeApproval());
  await context.step("verify revocation did not move the protected ref", () => environment.assertProtectedHead(proposal.baseCommit));
  await context.step("approve the first immutable revision again", () => ui.approveRevision());
  await context.step("verify renewed approval did not move the protected ref", () => environment.assertProtectedHead(proposal.baseCommit));
  const next = await context.step("force-rewrite the workspace proposal source", environment.advanceProposal);
  await context.step("show the rewritten source and keep old discussion while rejecting stale approval", () => ui.refreshAfterPush(next.candidate));
  await context.step("verify stale approval did not move the protected ref", () => environment.assertProtectedHead(proposal.baseCommit));
  await context.step("prepare and approve the current pull request revision", () => ui.approveRevision());
  const refreshFailure = await context.step("delay the accepted merge detail refresh", environment.delayNextPullRequestRefresh);
  await context.step("merge while navigating away and preserve the accepted pending state", () => ui.mergePullRequest({ title, siblingRef: next.siblingRef, refreshFailure, refreshBeforeResponse,
    ...(process.env.DIM_WEB_JOURNEY_CAPTURE_UI === "1" ? { evidenceDirectory: context.artifactDirectory } : {}) }));
  await context.step("verify the exact merged commit on the real main ref", () => environment.assertProtectedHead(next.candidate));
}
