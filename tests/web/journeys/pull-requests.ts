import type { JourneyContext } from "./support/context.js";
import { createReviewEnvironment, type ReviewEnvironment } from "./native-git/environment.js";
import { PullRequestUI } from "./native-git/pull-request-ui.js";

/** Assert user outcomes against disposable production services. DOM details live in the UI adapter. */
export async function runPullRequestJourney(context: JourneyContext, createEnvironment: () => Promise<ReviewEnvironment> = createReviewEnvironment) {
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
  await context.step("approve the first immutable revision", () => ui.approveRevision());
  const next = await context.step("push a new revision from the workspace", environment.advanceProposal);
  await context.step("keep old discussion and reject stale approval", async () => {
    await ui.refreshAfterPush();
    await environment.assertProtectedHead(proposal.baseCommit);
  });
  await context.step("review and merge the current pull request revision", async () => {
    await ui.approveRevision(); await ui.mergePullRequest(title);
  });
  await context.step("verify the exact merged commit on the real main ref", () => environment.assertProtectedHead(next.candidate));
}
