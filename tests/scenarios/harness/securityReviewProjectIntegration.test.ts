import { retainFilesRefPolicyExtension } from "../../../examples/features/security-review/ref-policy.ts";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createProjectReviewMatcher, type ProjectMatcherExecutor } from "../../../examples/features/security-review/project-matcher.ts";
import { reviewChangeMatcherExtension, type CodeReviewService } from "@slop-lab/dim-control-plane-plugin-code-review/plugin-api";
import { controlPlanePlugin as mergePlugin } from "@slop-lab/dim-control-plane-plugin-merge-policy";
import { basic, fixture, generationId, git, record, token } from "../../control-plane/plugins/git-repositories/optionalFeaturesFixture.js";

/** Ordinary CI verifies the adapter protocol without evaluating candidate code. */
const deterministicExecutor: ProjectMatcherExecutor = async ({ source, changes }) => {
  if (source.includes("return false;" ) && !source.includes("JSON.parse")) return false;
  return changes.some(({ oldPath, newPath, before, after }) => {
    if (![oldPath, newPath].includes("app/config.json")) return false;
    const oldValue = record(JSON.parse(before ?? "{}")), newValue = record(JSON.parse(after ?? "{}"));
    return ["allowHostAccess", "allowedCommands", "credentialScope"].some((key) => JSON.stringify(oldValue[key]) !== JSON.stringify(newValue[key]));
  });
};

it("enforces project-owned and JSON rules through real protected-ref promotion, including changing the evaluator itself", async () => {
  const live = process.env.DIM_TEST_PROJECT_MATCHER_DOCKER === "1";
  const provider = await createProjectReviewMatcher(live ? undefined : { execute: deterministicExecutor, revision: "e".repeat(64) });
  const promoter = { hostId: "host-a", username: "promoter", password: token(10) };
  const security = { reviewerId: "security", username: "security", password: token(11) };
  const merge = await mergePlugin.configure({ hostPromoters: [promoter] });
  const examplePolicy = record(JSON.parse(await readFile(new URL("../../../examples/features/security-review/repository-policy.json", import.meta.url), "utf8")));
  const { "code-review": reviewPolicy, ...additionalPolicies } = record(examplePolicy.extensions);
  const f = await fixture(true, [...(merge.extensions ?? []), reviewChangeMatcherExtension(provider), await retainFilesRefPolicyExtension()], reviewPolicy, [security], additionalPolicies);
  const headers = (credential: { username: string; password: string }) => ({ authorization: basic(credential), "content-type": "application/json", "x-dim-generation-id": generationId });
  try {
    const extension = f.service.context.extensions.find(({ kind, name }) => kind === "dim.code-review.service" && name === "default");
    if (extension === undefined) throw new Error("review service is missing");
    const reviews = extension.value as CodeReviewService;
    const propose = async () => {
      await git("/usr/bin/git", ["-C", f.source, "add", "."]);
      const candidate = await f.commit();
      await git("/usr/bin/git", ["-C", f.source, "push", "origin", `HEAD:${f.proposalRef}`]);
      const envelope = await reviews.create(f.service.context, { projectId: "project", repositoryId: "main", proposalRef: f.proposalRef });
      return { candidate, review: envelope.review, path: `${f.origin}/v1/projects/project/repositories/main/reviews/${envelope.review.reviewId}` };
    };
    type Proposal = Awaited<ReturnType<typeof propose>>;
    const head = async () => (await git("/usr/bin/git", ["--git-dir", join(f.root, "state/project/main.git"), "rev-parse", "refs/heads/main"])).stdout.trim();
    const promote = (proposal: Proposal) => fetch(`${proposal.path}/promotions`, { method: "POST", headers: headers(promoter), body: JSON.stringify({ schemaVersion: 1 }) });
    const requireSecurity = async (proposal: Proposal) => {
      expect(proposal.review.requiredReviewerIds).toEqual(["security"]);
      const protectedHead = await head();
      expect((await promote(proposal)).status).toBe(409);
      expect(await head()).toBe(protectedHead);
      const approval = await fetch(`${proposal.path}/approvals`, { method: "POST", headers: headers(security), body: JSON.stringify({ requestId: randomUUID() }) });
      expect(approval.status, await approval.clone().text()).toBe(201);
      const promoted = await promote(proposal);
      expect(promoted.status, await promoted.clone().text()).toBe(201);
      expect(await head()).toBe(proposal.candidate);
    };
    await mkdir(join(f.source, ".dim/review"), { recursive: true }); await mkdir(join(f.source, "app"));
    await writeFile(join(f.source, ".dim/review/matcher.mjs"), await readFile(new URL("../../../examples/features/security-review/repository/.dim/review/matcher.mjs", import.meta.url)));
    let config = { theme: "light", allowHostAccess: false, allowedCommands: ["build"], credentialScope: "none", runtime: { isolation: "container" } };
    const writeConfig = () => writeFile(join(f.source, "app/config.json"), JSON.stringify(config));
    await writeConfig();
    await requireSecurity(await propose());

    config = { ...config, theme: "dark" }; await writeConfig();
    const ordinary = await propose();
    expect(ordinary.review.requiredReviewerIds).toEqual([]);
    expect((await promote(ordinary)).status).toBe(201);
    expect(await head()).toBe(ordinary.candidate);

    config = { ...config, allowHostAccess: true }; await writeConfig();
    await requireSecurity(await propose());
    config = { ...config, runtime: { isolation: "host" } }; await writeConfig();
    await requireSecurity(await propose());

    // This candidate tries to disable its own evaluator. Mandatory review remains.
    await writeFile(join(f.source, ".dim/review/matcher.mjs"), "// @ts-check\nexport function matches(){return false;}\n");
    await requireSecurity(await propose());

    // Human review cannot override the independent retain-files policy.
    await rm(join(f.source, ".dim/review/matcher.mjs"));
    const deletion = await propose();
    expect(deletion.review.requiredReviewerIds).toEqual(["security"]);
    const approved = await fetch(`${deletion.path}/approvals`, { method: "POST", headers: headers(security), body: JSON.stringify({ requestId: randomUUID() }) });
    expect(approved.status, await approved.clone().text()).toBe(201);
    const previousHead = await head();
    expect((await promote(deletion)).status).toBe(409);
    expect(await head()).toBe(previousHead);
  } finally { await f.service.close(); await rm(f.root, { recursive: true, force: true }); }
}, 120_000);
