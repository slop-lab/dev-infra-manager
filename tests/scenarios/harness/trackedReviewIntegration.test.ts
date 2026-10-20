import { randomUUID } from "node:crypto";
import { cp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createReadTracker, reviewTraceRuntimeExtension, type ReviewTraceRuntime } from "@slop-lab/dim-review-tracing";
import { prepareReviewTracing } from "@slop-lab/dim-control-plane-plugin-review-tracing";
import { createNodeReviewTraceRuntime } from "@slop-lab/dim-control-plane-plugin-review-tracing-node";
import type { CodeReviewService } from "@slop-lab/dim-control-plane-plugin-code-review/extensions";
import { controlPlanePlugin as mergePlugin } from "@slop-lab/dim-control-plane-plugin-merge-policy";
import { basic, fixture, generationId, git, record, token } from "../../control-plane/plugins/git-repositories/optionalFeaturesFixture.js";

/** Only candidate execution is substituted in ordinary CI. Reads use the real broker/tracker. */
const deterministicRuntime: ReviewTraceRuntime = {
  name: "node", revision: "e".repeat(64),
  async evaluate(input) {
    const tracker = createReadTracker(input);
    const read = async (path: string) => {
      const value = await tracker.read(path, "dependency");
      if (value === undefined) throw new Error(`missing dependency ${path}`);
      return value.toString("utf8");
    };
    const source = await read(input.entrypoint);
    if (source.includes("throw Error('broken')")) throw new Error("broken matcher");
    if (source.includes("return false;")) return { matches: false, manifest: tracker.manifest() };
    if (source.includes("readTarget('.dim/review/helper.mjs')")) {
      await tracker.read(".dim/review/helper.mjs", "target");
      return { matches: false, manifest: tracker.manifest() };
    }
    await read(".dim/review/helper.mjs");
    const settings = record(JSON.parse(await read(".dim/review/settings.json")));
    const before = record(JSON.parse((await tracker.read("app/config.json", "target", "before"))?.toString() ?? "{}"));
    const after = record(JSON.parse((await tracker.read("app/config.json", "target", "after"))?.toString() ?? "{}"));
    const previous = record(before.runtime ?? {}), next = record(after.runtime ?? {});
    if (next.inspectExtra === true) await read(".dim/review/extra.json");
    return { matches: settings.watchIsolation === true && previous.isolation !== next.isolation, manifest: tracker.manifest() };
  }
};

it("automatically protects imported and read dependencies while interpreting target fields through real protected-ref review and promotion", async () => {
  const runtime = process.env.DIM_TEST_REVIEW_TRACE_DOCKER === "1" ? await createNodeReviewTraceRuntime() : deterministicRuntime;
  const promoter = { hostId: "host-a", username: "promoter", password: token(10) };
  const security = { reviewerId: "security", username: "security", password: token(11) };
  const merge = await mergePlugin.configure({ hostPromoters: [promoter] });
  const tracing = prepareReviewTracing();
  const policy = record(JSON.parse(await readFile(new URL("../../../examples/features/review-tracing/repository-policy.json", import.meta.url), "utf8")));
  const { "code-review": reviewPolicy, ...additionalPolicies } = record(policy.extensions);
  const f = await fixture(true, [...(merge.extensions ?? []), ...tracing.extensions, reviewTraceRuntimeExtension(runtime)], reviewPolicy, [security], additionalPolicies);
  const headers = (credential: { username: string; password: string }) => ({ authorization: basic(credential), "content-type": "application/json", "x-dim-generation-id": generationId });
  try {
    const extension = f.service.context.extensions.find(({ kind, name }) => kind === "dim.code-review.service" && name === "default");
    if (extension === undefined) throw new Error("review service is missing");
    const reviews = extension.value as CodeReviewService;
    const propose = async () => {
      await git("/usr/bin/git", ["-C", f.source, "add", "."]);
      const candidate = await f.commit();
      // Write leases are intentionally short-lived; real isolated evaluations can span several leases.
      const leased = await fetch(`${f.origin}/v1/projects/project/repositories/main/workspace-write-leases`, {
        method: "POST", headers: headers({ username: "writer", password: token(2) }),
        body: JSON.stringify({ schemaVersion: 1, generationId, repositoryId: "main", workspaceId: token(6) })
      });
      expect(leased.status, await leased.clone().text()).toBe(201);
      const lease = record(await leased.json());
      if (typeof lease.username !== "string" || typeof lease.password !== "string") throw new Error("write lease credentials are missing");
      const remote = new URL(`/v1/projects/project/repositories/main.git`, f.origin);
      remote.username = lease.username; remote.password = lease.password;
      await git("/usr/bin/git", ["-C", f.source, "remote", "set-url", "origin", remote.toString()]);
      await git("/usr/bin/git", ["-C", f.source, "push", "origin", `HEAD:${f.proposalRef}`]);
      const envelope = await reviews.create(f.service.context, { projectId: "project", repositoryId: "main", proposalRef: f.proposalRef });
      return { candidate, review: envelope.review, path: `${f.origin}/v1/projects/project/repositories/main/reviews/${envelope.review.reviewId}` };
    };
    type Proposal = Awaited<ReturnType<typeof propose>>;
    const head = async () => (await git("/usr/bin/git", ["--git-dir", join(f.root, "state/project/main.git"), "rev-parse", "refs/heads/main"])).stdout.trim();
    const promote = (proposal: Proposal) => fetch(`${proposal.path}/promotions`, { method: "POST", headers: headers(promoter), body: JSON.stringify({ schemaVersion: 1 }) });
    const requireSecurity = async (proposal: Proposal) => {
      expect(proposal.review.requiredReviewerIds).toEqual(["security"]);
      const previous = await head();
      expect((await promote(proposal)).status).toBe(409);
      expect(await head()).toBe(previous);
      const approved = await fetch(`${proposal.path}/approvals`, { method: "POST", headers: headers(security), body: JSON.stringify({ requestId: randomUUID() }) });
      expect(approved.status, await approved.clone().text()).toBe(201);
      const promoted = await promote(proposal);
      expect(promoted.status, await promoted.clone().text()).toBe(201);
      expect(await head()).toBe(proposal.candidate);
    };
    await cp(new URL("../../../examples/features/review-tracing/repository/", import.meta.url), f.source, { recursive: true });
    const matcherPath = join(f.source, ".dim/review/matcher.mjs"), helperPath = join(f.source, ".dim/review/helper.mjs");
    const matcher = await readFile(matcherPath, "utf8"), helper = await readFile(helperPath, "utf8");
    let config = { theme: "light", runtime: { isolation: "container", inspectExtra: false } };
    const writeConfig = () => writeFile(join(f.source, "app/config.json"), JSON.stringify(config));
    await writeConfig();
    await requireSecurity(await propose()); // No existing protected matcher: bootstrap requires review.

    config = { ...config, theme: "dark" }; await writeConfig();
    const ordinary = await propose();
    expect(ordinary.review.requiredReviewerIds).toEqual([]);
    expect((await promote(ordinary)).status).toBe(201);

    config = { ...config, runtime: { ...config.runtime, isolation: "host" } }; await writeConfig();
    await requireSecurity(await propose());

    // A helper edit that leaves the predicate's answer false is still protected.
    await writeFile(helperPath, `${helper}\n// reviewed helper update\n`);
    await requireSecurity(await propose());
    await writeFile(join(f.source, ".dim/review/settings.json"), '{"watchIsolation":false}\n');
    await requireSecurity(await propose());

    // No matcher/helper edit: a target field activates an additional dependency.
    await writeFile(join(f.source, ".dim/review/extra.json"), '{"scope":"limited"}\n');
    config = { ...config, runtime: { ...config.runtime, inspectExtra: true } }; await writeConfig();
    await requireSecurity(await propose());

    // A candidate cannot downgrade a previously imported helper to target data.
    await writeFile(matcherPath, "// @ts-check\nimport {readTarget} from 'dim:review';\nexport async function matches(){await readTarget('.dim/review/helper.mjs');return Boolean(0);}\n");
    await requireSecurity(await propose());
    await writeFile(matcherPath, "// @ts-check\nexport function matches(){return false;}\n");
    await requireSecurity(await propose());

    // Restore the working matcher, then prove broken or missing candidate code fails closed.
    await writeFile(matcherPath, matcher); await requireSecurity(await propose());
    await writeFile(matcherPath, "// @ts-check\nexport function matches(){throw Error('broken')}\n");
    await expect(propose()).rejects.toThrow();
    await rm(matcherPath);
    await expect(propose()).rejects.toThrow();
  } finally { try { await f.service.close(); } finally { await rm(f.root, { recursive: true, force: true }); } }
}, 180_000);
