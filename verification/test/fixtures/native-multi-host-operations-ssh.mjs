#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const separator = process.argv.indexOf("--");
if (separator < 0) process.exit(98);
const target = process.argv[separator + 1];
const command = process.argv.slice(separator + 2);
const includesSequence = (first, second) => command.some((value, index) => value === first && command[index + 1] === second);
const needsInput = includesSequence("bash", "-s")
  || (command[0] === "node" && command.includes("-"))
  || (command[0] === "docker" && command[1] === "exec" && command.includes("-"));
const payload = needsInput ? readFileSync(0, "utf8") : "";
appendFileSync(process.env.OPS_FAKE_LOG, `${JSON.stringify({ target, command, payload })}\n`);

const contains = (value) => payload.includes(value) || command.includes(value);
const argumentAfter = (value) => command[command.indexOf(value) + 1];
const repeat = (value, length) => value.repeat(length);
const markerDigest = (value) => `sha256:${createHash("sha256").update(`${value}\n`).digest("hex")}`;

if (payload.includes("prepared_state=")) {
  const machine = target === "control" ? "control" : "ordinary";
  process.stdout.write(`${JSON.stringify({ role: target, hostname: target, machineId: machine,
    bootId: `boot-${machine}`, dockerId: `docker-${machine}`, stateIdentity: `state-${machine}`,
    sourceRoot: `/srv/${target}`, commit: repeat("a", 40), dimVersion: "0.9.0",
    aggregateLockSha256: repeat("b", 64), packageSha256: repeat("c", 64),
    preparedImageRef: `image@sha256:${repeat("d", 64)}`,
    preparedImageId: `sha256:${repeat(target === "control" ? "e" : "f", 64)}` })}\n`);
  process.exit(0);
}
if (payload.includes('kind="$1"')) {
  process.stdout.write(`${command.includes("qemu") ? "qemu-a" : "ordinary-a"}\n`);
  process.exit(0);
}
if (payload.includes("projects=")) process.exit(0);
if (payload.includes("just install-local")) process.exit(0);
if (contains("installer") && contains("control-plane")) process.exit(0);
if (command.includes("controller") && command.includes("restart")) {
  if (!command.includes("DIM_NATIVE_CONTROL_PLANE_CONNECTION_FILE=/etc/dim/control.json")
    || !command.includes("DIM_NATIVE_ROOT_IMPORTER_CONNECTION_FILE=/etc/dim/importer.json")) process.exit(96);
  process.exit(0);
}

if (payload.includes("bootstrap-native-root")) {
  writeFileSync(join(process.env.OPS_FAKE_STATE, "workspace.json"), JSON.stringify({
    schemaVersion: 9, name: "ops-workspace", projectName: "ops-project", phase: "ready",
    rootCommit: repeat("f", 40), workspaceId: repeat("A", 43)
  }));
  if (process.env.OPS_FAKE_MODE === "setup-failure") {
    writeFileSync(join(process.env.OPS_FAKE_STATE, "setup-failed"), "1\n");
    process.exit(9);
  }
  process.stdout.write(`${repeat("A", 43)}\n`);
  process.exit(0);
}
if (command.includes("workspace") && command.includes("show") && payload === "") {
  process.stdout.write(readFileSync(join(process.env.OPS_FAKE_STATE, "workspace.json"), "utf8"));
  process.exit(0);
}
if (payload.includes("workspace cleanup identity")) {
  const workspace = join(process.env.OPS_FAKE_STATE, "workspace.json");
  if (existsSync(workspace)) rmSync(workspace);
  process.exit(0);
}
if (payload.includes("ls-remote --refs")) {
  process.stdout.write(`${repeat("f", 40)}\n`);
  process.exit(0);
}

if (payload.includes('proposal="refs/heads/proposals')) {
  const attempt = Number(command.at(-1));
  createAttempt(attempt);
  process.exit(0);
}
if (command[0] === "docker" && command[1] === "exec") {
  if (!command.includes("--interactive")) process.exit(90);
  const nodeIndex = command.indexOf("node");
  const nodeArguments = command.slice(nodeIndex + 1);
  const dash = nodeArguments.indexOf("-");
  nodeArguments[dash + 1] = process.env.OPS_FAKE_REPOSITORY;
  const result = spawnSync(process.execPath, nodeArguments, { input: payload, encoding: "utf8" });
  process.stdout.write(result.stdout); process.stderr.write(result.stderr); process.exit(result.status ?? 1);
}
if (command[0] === "node" && payload.includes("/healthz")) process.exit(0);
if (command[0] === "systemctl" && command.includes("show")) {
  const countPath = join(process.env.OPS_FAKE_STATE, "invocations");
  const count = existsSync(countPath) ? Number(readFileSync(countPath, "utf8")) + 1 : 1;
  writeFileSync(countPath, String(count));
  if (target === "control") process.stdout.write(count < 3
    ? `${repeat("1", 32)}\n${repeat("2", 32)}\n` : `${repeat("4", 32)}\n${repeat("5", 32)}\n`);
  else process.stdout.write(count < 3 ? `${repeat("3", 32)}\n` : `${repeat("6", 32)}\n`);
  process.exit(0);
}
if (command[0] === "systemctl") process.exit(0);

if (payload.includes("dev.dim.native-qemu.claim")) {
  if (process.env.OPS_FAKE_MODE === "setup-failure"
    && existsSync(join(process.env.OPS_FAKE_STATE, "setup-failed"))) process.exit(9);
  process.exit(0);
}
if (payload.includes("dim.kind=native-ordinary-runner")) process.exit(0);
process.exit(97);

function createAttempt(attempt) {
  const candidateCommit = repeat(String(attempt), 40);
  const candidateTree = repeat(String(attempt + 2), 40);
  const reviewId = repeat(String(attempt + 4), 64);
  const envelopeId = repeat(String(attempt + 6), 64);
  const proposalRef = `refs/heads/proposals/${repeat("A", 43)}/native-operations-run-${attempt}`;
  const jobs = [{ executionKind: "ordinary-sysbox", jobName: "source", evidenceClass: "candidate-controlled" },
    { executionKind: "qemu", jobName: "integration", evidenceClass: "candidate-controlled" }];
  const repository = process.env.OPS_FAKE_REPOSITORY;
  const reviewRoot = join(repository, "dim-authoritative-reviews", "proposals");
  mkdirSync(reviewRoot, { recursive: true });
  writeFileSync(join(reviewRoot, `${reviewId}.${envelopeId}.json`), JSON.stringify({ schemaVersion: 2, envelopeId,
    review: { schemaVersion: 2, serviceId: "native-main", projectId: "ops-project", repositoryId: "root",
      protectedRef: "refs/heads/main", proposalRef, expectedProtectedHead: repeat("f", 40), candidateCommit,
      candidateTree, reviewId, policyRevision: repeat("a", 64), requiredReviewRevision: repeat("b", 64),
      workspaceId: repeat("A", 43), requiredReviewerIds: ["owner"], changes: [], patch: "", patchBytes: "", createdAt: "2026-01-01T00:00:00.000Z" },
    qualityRevision: repeat("c", 64), policyDigest: repeat("d", 64), planning: { status: "valid", jobs },
    requiredJobs: jobs, events: jobs.map((job) => ({ schemaVersion: 3, type: "dim.native.review-job.available", ...job })) }));
  const ordinaryRoot = join(repository, "dim-authoritative-statuses", "ordinary-sysbox", reviewId, "source");
  mkdirSync(ordinaryRoot, { recursive: true });
  writeFileSync(join(ordinaryRoot, "1.json"), JSON.stringify(terminal("ordinary-sysbox", "source", "ordinary-a",
    "ordinary-ok", `ordinary-${attempt}`, reviewId, candidateCommit, candidateTree)));
  const qemuRoot = join(repository, "dim-authoritative-qemu");
  mkdirSync(qemuRoot, { recursive: true });
  const statePath = join(qemuRoot, "state.json");
  const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : { schemaVersion: 1, attempts: [], statuses: [] };
  const qemuAttempt = `qemu-${attempt}`;
  state.attempts.push({ reviewId, attemptId: qemuAttempt, descriptor: { jobName: "integration" } });
  state.statuses.push({ schemaVersion: 1, attemptId: qemuAttempt, result: "success",
    event: terminal("qemu", "integration", "qemu-a", "qemu-ok", qemuAttempt, reviewId, candidateCommit, candidateTree) });
  writeFileSync(statePath, JSON.stringify(state));
  process.stdout.write(`${JSON.stringify({ proposalRef, candidateCommit, candidateTree })}\n`);
}

function terminal(kind, jobName, hostId, marker, attemptId, reviewId, candidateCommit, candidateTree) {
  return { schemaVersion: kind === "qemu" ? 1 : 3, eventId: `${kind}-${attemptId}`, payload: { executionKind: kind, reviewId, attemptId,
    hostId, result: "success", completion: { kind: "exited", exitCode: 0 }, stdout: { sha256: markerDigest(marker), truncated: false },
    stderr: { truncated: false }, descriptor: { jobName, candidateCommit, candidateTree, expectedProtectedHead: repeat("f", 40) } } };
}
