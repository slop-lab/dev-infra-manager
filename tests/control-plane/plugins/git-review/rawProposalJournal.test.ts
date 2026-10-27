import { createHash, randomUUID } from "node:crypto";
import { chmod, link, mkdtemp, open, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  rawProposalJobId,
  readRawProposalJobs,
  stageRawProposalJob,
  type RawProposalBinding,
  type RawProposalJob
} from "../../../../packages/control-plane/plugins/git-review/src/raw-proposal-journal.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it("discards a valid uncommitted replacement after a same-process restart check", async () => {
  // Given
  const repository = await createRepository();
  const pending = await stageRawProposalJob(repository, binding("replacement"));
  const replacement = { ...pending, state: { status: "failed", failure: "review-preparation-failed" } } satisfies RawProposalJob;
  const staged = await writeStaged(repository, replacement);

  // When
  const recovered = await readRawProposalJobs(repository);

  // Then
  expect(recovered).toEqual([pending]);
  expect(await readdir(stagingRoot(repository))).toEqual([]);
  await expect(open(staged, "r")).rejects.toMatchObject({ code: "ENOENT" });
});

it("discards a valid single-link create that was never published", async () => {
  // Given
  const repository = await createRepository();
  await readRawProposalJobs(repository);
  const job = rawJob(binding("uncommitted-create"));
  await writeStaged(repository, job);

  // When
  const recovered = await readRawProposalJobs(repository);

  // Then
  expect(recovered).toEqual([]);
  expect(await readdir(stagingRoot(repository))).toEqual([]);
});

it("retains an accepted two-link publication and removes its crash residue", async () => {
  // Given
  const repository = await createRepository();
  await readRawProposalJobs(repository);
  const job = rawJob(binding("published"));
  const staged = await writeStaged(repository, job);
  await link(staged, recordPath(repository, job.jobId));

  // When
  const recovered = await readRawProposalJobs(repository);

  // Then
  expect(recovered).toEqual([job]);
  expect(await readdir(stagingRoot(repository))).toEqual([]);
});

it.each(["malformed", "wrong-identity"])("rejects %s staged crash residue without deleting it", async (kind) => {
  // Given
  const repository = await createRepository();
  await readRawProposalJobs(repository);
  const expected = rawJob(binding("expected"));
  const staged = join(stagingRoot(repository), `${expected.jobId}.json.${randomUUID()}.tmp`);
  const serialized = kind === "malformed" ? "{" : `${JSON.stringify(rawJob(binding("other")))}\n`;
  await writeFile(staged, serialized, { mode: 0o600 });

  // When / Then
  await expect(readRawProposalJobs(repository)).rejects.toThrow();
  expect(await readdir(stagingRoot(repository))).toEqual([staged.split("/").at(-1)]);
});

it.each(["public-mode", "staging-symlink"])("revalidates live private storage after %s tampering", async (kind) => {
  // Given
  const repository = await createRepository();
  await readRawProposalJobs(repository);
  if (kind === "public-mode") await chmod(join(repository, "dim-raw-proposal-jobs"), 0o755);
  if (kind === "staging-symlink") {
    const staging = stagingRoot(repository);
    const replacement = await mkdtemp(join(tmpdir(), "dim-raw-journal-staging-"));
    roots.push(replacement);
    await rm(staging, { recursive: true });
    await symlink(replacement, staging);
  }
  // When / Then
  await expect(readRawProposalJobs(repository)).rejects.toThrow();
});

it("rejects storage owned by a different service identity on same-process reuse", async () => {
  // Given
  const repository = await createRepository();
  await readRawProposalJobs(repository);
  const getuid = process.getuid;
  const uid = getuid?.();
  if (uid === undefined || getuid === undefined) throw new Error("test requires a Linux user identity");
  Object.defineProperty(process, "getuid", { configurable: true, value: () => uid + 1 });

  try {
    // When / Then
    await expect(readRawProposalJobs(repository)).rejects.toThrow();
  } finally {
    Object.defineProperty(process, "getuid", { configurable: true, value: getuid });
  }
});

it("serializes admission at 100000 records and still allows a duplicate", async () => {
  // Given
  const repository = await createRepository();
  const accepted = await stageRawProposalJob(repository, binding("accepted"));
  await fillCapacity(repository, accepted.jobId, 99_999);
  const first = binding("first-at-boundary");
  const second = binding("second-at-boundary");

  // When
  const outcomes = await Promise.allSettled([
    stageRawProposalJob(repository, first),
    stageRawProposalJob(repository, second)
  ]);

  // Then
  expect(outcomes.map(({ status }) => status).sort()).toEqual(["fulfilled", "rejected"]);
  expect(await readdir(recordsRoot(repository))).toHaveLength(100_000);
  await expect(stageRawProposalJob(repository, accepted.binding)).resolves.toEqual(accepted);
}, 30_000);

async function createRepository(): Promise<string> {
  const repository = await mkdtemp(join(tmpdir(), "dim-raw-journal-"));
  roots.push(repository);
  return repository;
}

function binding(label: string): RawProposalBinding {
  const object = createHash("sha1").update(label).digest("hex");
  return {
    schemaVersion: 1,
    generationId: "1".repeat(64),
    projectId: "project",
    repositoryId: "repository",
    proposalRef: `refs/heads/proposals/${label}`,
    protectedRef: "refs/heads/main",
    expectedProtectedHead: "2".repeat(40),
    candidateCommit: object,
    candidateTree: "3".repeat(40),
    policyDigest: "4".repeat(64),
    authority: {
      ownerHostId: "host",
      importGenerationId: "5".repeat(64),
      importNonce: "00000000-0000-4000-8000-000000000000",
      bundleDigest: "6".repeat(64),
      resolvedTree: "7".repeat(40),
      headSequence: 1,
      headTree: "8".repeat(40)
    }
  };
}

function rawJob(input: RawProposalBinding): RawProposalJob {
  return { jobId: rawProposalJobId(input), capturedAt: "2026-10-27T00:00:00.000Z", binding: input, state: { status: "pending" } };
}

async function writeStaged(repository: string, job: RawProposalJob): Promise<string> {
  const path = join(stagingRoot(repository), `${job.jobId}.json.${randomUUID()}.tmp`);
  const file = await open(path, "wx", 0o600);
  try {
    await file.writeFile(`${JSON.stringify(job)}\n`, "utf8");
    await file.sync();
  } finally {
    await file.close();
  }
  return path;
}

async function fillCapacity(repository: string, acceptedJobId: string, target: number): Promise<void> {
  const records = recordsRoot(repository);
  const names = Array.from({ length: target - 1 }, (_, index) =>
    createHash("sha256").update(`capacity-${String(index)}`).digest("hex"));
  const available = names.filter((name) => name !== acceptedJobId);
  const firstSeed = join(records, `${available[0]}.json`);
  const secondSeed = join(records, `${available[1]}.json`);
  await writeFile(firstSeed, "{}\n", { mode: 0o600 });
  await writeFile(secondSeed, "{}\n", { mode: 0o600 });
  const links = available.slice(2, target - 1);
  for (let index = 0; index < links.length; index += 500) {
    await Promise.all(links.slice(index, index + 500).map((name, offset) =>
      link((index + offset) % 2 === 0 ? firstSeed : secondSeed, join(records, `${name}.json`))));
  }
}

function recordsRoot(repository: string): string {
  return join(repository, "dim-raw-proposal-jobs", "records");
}

function stagingRoot(repository: string): string {
  return join(repository, "dim-raw-proposal-jobs", "staging");
}

function recordPath(repository: string, jobId: string): string {
  return join(recordsRoot(repository), `${jobId}.json`);
}
