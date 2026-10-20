import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { workflowCompilerExtension } from "@slop-lab/dim-contracts-ci/workflow";
import { parseAuthoritativeNativeReviewEnvelope } from "@slop-lab/dim-control-plane-plugin-code-review/extensions";
import { prepareGitCi } from "../../../../packages/control-plane/plugins/git-ci/src/index.js";
import type { GitCiQualityInput } from "../../../../packages/control-plane/plugins/git-ci/src/quality.js";
import { basic, fixture, generationId, git, reviewer, token } from "../git-repositories/optionalFeaturesFixture.js";

it("leaves a human-review-only repository free of CI even when Git CI is installed", async () => {
  let compiled = false;
  const prepared = prepareGitCi({ compiler: "dim", grantIssuer: { username: "grants", password: token(20) },
    candidateReader: { username: "candidate", password: token(21) }, resultReporter: { username: "results", password: token(22) },
    webhook: { username: "webhook", password: token(23), endpoint: "http://127.0.0.1:1/v1/jobs" } });
  const f = await fixture(true, [workflowCompilerExtension("dim", { configurationPath: ".dim/ci/runner.yml",
    compile() { compiled = true; throw new Error("unselected workflow must not be read"); } }), ...(prepared.extensions ?? [])]);
  try {
    await mkdir(join(f.source, ".dim/ci"), { recursive: true });
    await writeFile(join(f.source, ".dim/ci/runner.yml"), "invalid workflow deliberately ignored\n");
    await git("/usr/bin/git", ["-C", f.source, "add", "."]); await f.commit();
    await git("/usr/bin/git", ["-C", f.source, "push", "origin", `HEAD:${f.proposalRef}`]);
    const response = await fetch(`${f.origin}/v1/projects/project/repositories/main/reviews/resolve`, { method: "POST",
      headers: { authorization: basic(reviewer), "x-dim-generation-id": generationId, "content-type": "application/json" },
      body: JSON.stringify({ schemaVersion: 1, proposalRef: f.proposalRef }) });
    expect(response.status).toBe(200);
    const envelope = parseAuthoritativeNativeReviewEnvelope(await response.json());
    expect(envelope.attachments).toEqual([]); expect(compiled).toBe(false);
    const extension = prepared.extensions?.find(({ kind }) => kind === "dim.merge-policy.quality-guard");
    if (!extension) throw new Error("quality guard is missing");
    const guard = extension.value as { check(input: GitCiQualityInput): Promise<readonly unknown[]> };
    expect(await guard.check({ ...envelope.review, repository: join(f.root, "state/project/main.git"),
      policyDigest: envelope.policyDigest, attachments: envelope.attachments })).toEqual([]);
  } finally { await f.service.close(); await rm(f.root, { recursive: true, force: true }); }
}, 20_000);
