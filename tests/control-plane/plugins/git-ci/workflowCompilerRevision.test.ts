import { randomUUID } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import type { WorkflowCompiler } from "@slop-lab/gs-ci-contracts";
import { encodeDimReviewJobAvailableEvent } from "@slop-lab/dim-contracts-ci/execution";
import { dimWorkflowCompiler } from "@slop-lab/dim-control-plane-plugin-ci-workflows";
import { gitCiPreparation } from "../../../../packages/control-plane/plugins/git-ci/src/preparation.js";
import * as planStore from "../../../../packages/gs/ci/src/plan-store.js";
import { nativeBundleReviewFixture, publishedReviewEnvelopes } from "./nativeBundleReviewFixture.js";
import { cleanupFinalizeFixtures, generationId } from "../git-repositories/nativeRootImportFinalizeFixture.js";
import { idleNativeConfig } from "../git-repositories/bundleConfigFixture.js";
import { slot } from "../../../contracts/ci/executionFixture.js";

afterEach(cleanupFinalizeFixtures);

it("tracks the selected same-name DIM compiler revision in the review provider proof", () => {
  let selected = compiler("a".repeat(64));
  const preparation = gitCiPreparation(() => selected, undefined, "dim");
  const revisionA = preparation.revision;

  selected = compiler("b".repeat(64));

  expect(preparation.revision).not.toBe(revisionA);
});

it("binds a stored plan attachment to the exact workflow provider revision", () => {
  const bind = Reflect.get(planStore, "bindGitCiPlanAttachment");
  const verify = Reflect.get(planStore, "assertGitCiPlanAttachmentProvider");
  const stored = { kind: "git-ci", id: "c".repeat(64), digest: "c".repeat(64) };

  expect(bind).toBeDefined();
  expect(verify).toBeDefined();
  const attachment = bind(stored, { name: "dim", revision: "a".repeat(64) });
  expect(() => verify(attachment, { name: "dim", revision: "b".repeat(64) })).toThrow(/provider|revision|stale/i);
});

it("rejects a reviewed DIM plan after its same-name compiler revision changes", async () => {
  let revision = "a".repeat(64);
  const mutableCompiler: WorkflowCompiler = {
    ...dimWorkflowCompiler,
    get revision() { return revision; },
  };
  const fixture = await nativeBundleReviewFixture(
    "workflow-compiler-revision", undefined, undefined, undefined, undefined, undefined,
    undefined, {}, undefined, undefined, undefined, "root", mutableCompiler,
  );
  const envelope = (await publishedReviewEnvelopes(fixture.root))[0];
  const event = envelope?.events[0];
  if (event === undefined) throw new Error("reviewed compiler event is missing");
  const config = idleNativeConfig();
  const request = async () => fetch(`${fixture.service.origin}/v1/execution-grants`, {
    method: "POST",
    headers: {
      authorization: `Basic ${Buffer.from(`${config.ci.grantIssuer.username}:${config.ci.grantIssuer.password}`).toString("base64")}`,
      "x-dim-generation-id": generationId,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      executionId: randomUUID(),
      generationId,
      event: encodeDimReviewJobAvailableEvent(event),
      workerId: "worker-a",
      slotId: slot.id,
      profile: slot.profile,
    }),
  });
  expect((await request()).status).toBe(201);

  revision = "b".repeat(64);

  const stale = await request();
  expect(stale.status).toBe(409);
  expect(await stale.text()).toMatch(/stale|conflict|review/i);
});

function compiler(revision: string): WorkflowCompiler {
  return {
    configurationPath: ".dim/ci/runner.yml",
    revision,
    compile: () => [],
  };
}
