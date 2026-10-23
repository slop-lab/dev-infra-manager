import type { JourneyContext } from "./support/context.js";
import { createReviewEnvironment, type ReviewEnvironment } from "./native-git/environment.js";
import { ReviewUI } from "./native-git/ui.js";

/** User outcomes stay stable; screen details belong to the replaceable UI adapter.
 * This fixture is destructive only inside its disposable state directory. */
export async function runReviewJourney(context: JourneyContext, createEnvironment: () => Promise<ReviewEnvironment> = createReviewEnvironment) {
  const environment = await context.step("prepare disposable services", createEnvironment);
  context.cleanup(environment.close);
  const ui = new ReviewUI(context.page);
  await context.step("sign in as the default operator", () => ui.signIn(environment.origin, environment.username, environment.password));
  await context.step("create a managed project", async () => { await ui.openReviews(); await ui.createProject(environment.projectId); });
  await context.step("import a repository through the UI", async () => {
    await ui.importRepository(environment.repositoryId, environment.upstreamUrl);
    await environment.assertProjectImported();
  });
  const proposal = await context.step("prepare a workspace proposal and pending review", environment.prepareProposal);
  await context.step("inspect changes requiring review", () => ui.openPendingProposal(proposal.proposalRef));
  await context.step("discover missing reviewer access", () => ui.expectReviewerAccessRequired());
  await context.step("grant reviewer access through account settings", () => ui.grantOwnReviewerRole(environment.username, environment.password));
  await context.step("sign in again and reopen the proposal", async () => {
    await ui.signIn(environment.origin, environment.username, environment.password);
    await ui.openReviews(environment.projectId, environment.repositoryId);
    await ui.inspectProposal(proposal.proposalRef);
  });
  await context.step("approve and promote the inspected candidate", () => ui.approveAndPromote());
  await context.step("verify the actual protected Git ref", () => environment.assertProtectedHead(proposal.candidate));
}
