import type { Server } from "node:http";
import type { NativeGitBundleConfig } from "./bundle-config.js";
import type { AdmissionVerifierHttpClient } from "./ordinary-admission-http.js";
import type { NativeProjectRootReadHooks } from "./native-project-root-read-http.js";
import type { NativeProjectWorkspaceWriteHooks } from "./native-project-workspace-write-http.js";
import type { AuthoritativeNativeReviewHooks } from "./authoritative-native-review.js";
import type { AuthoritativeNativeReviewEnvelope } from "./authoritative-native-review-schema.js";
import type { NativeHumanReviewerHooks } from "./native-human-reviewer-http.js";
import type { AuthoritativeOrdinaryExecutionDescriptor } from "./authoritative-ordinary-execution-descriptor.js";
import type { AuthoritativeQemuExecutionDescriptor } from "./authoritative-qemu-execution-descriptor.js";
import type { ReviewPublicationFaults } from "./review-record-storage.js";
import type { NativeOrdinaryAttemptHooks } from "./native-ordinary-attempt-http.js";
import type {
  AuthoritativeOrdinaryTerminalEvent
} from "./authoritative-ordinary-status-schema.js";
import type { OrdinaryTerminalProvenance } from "./ordinary-current-terminal-proof.js";

export type NativeGitBundleServerOptions = {
  readonly config: NativeGitBundleConfig;
  readonly stateDirectory: string;
  readonly readinessToken: string;
  readonly activationToken: string;
  readonly expectedGenerationId: string;
  readonly ordinaryIdentityHttpClient?: AdmissionVerifierHttpClient;
  readonly deliveryFaults?: ReviewPublicationFaults;
  readonly rootReadLeaseClock?: () => number;
  readonly rootReadLeaseHooks?: NativeProjectRootReadHooks;
  readonly workspaceWriteLeaseClock?: () => number;
  readonly workspaceWriteLeaseHooks?: NativeProjectWorkspaceWriteHooks;
  readonly authoritativeReviewHooks?: AuthoritativeNativeReviewHooks;
  readonly nativeHumanReviewerHooks?: NativeHumanReviewerHooks;
  readonly nativeOrdinaryAttemptHooks?: NativeOrdinaryAttemptHooks;
};

export type AuthoritativeNativeReviewSelector = {
  readonly projectId: string;
  readonly repositoryId: "root";
  readonly proposalRef: string;
};

export type NativeGitPreparedProject = {
  readonly serviceId: "native-main";
  readonly projectId: string;
  readonly rootRepositoryId: "root";
  readonly state: "root-prepared";
};

export type CurrentOrdinaryTerminalEvidenceSelector = {
  readonly projectId: string;
  readonly reviewId: string;
  readonly jobName: string;
};

export type CurrentOrdinaryTerminalEvidence = {
  readonly schemaVersion: 1;
  readonly executionKind: "ordinary-sysbox";
  readonly evidenceClass: "candidate-controlled";
  readonly projectId: string;
  readonly repositoryId: "root";
  readonly reviewId: string;
  readonly jobName: string;
  readonly attemptId: string;
  readonly attempt: number;
  readonly descriptorDigest: string;
  readonly hostId: string;
  readonly capacity: string;
  readonly result: AuthoritativeOrdinaryTerminalEvent["payload"]["result"];
  readonly completion: AuthoritativeOrdinaryTerminalEvent["payload"]["completion"];
  readonly terminalEvent: AuthoritativeOrdinaryTerminalEvent;
  readonly provenance: OrdinaryTerminalProvenance;
};

export type NativeGitBundleServer = {
  readonly server: Server;
  listen(host?: string, port?: number): Promise<string>;
  prepareProject(generationId: string, ownerHostId: string, input: unknown): Promise<NativeGitPreparedProject>;
  createReview(input: AuthoritativeNativeReviewSelector): Promise<AuthoritativeNativeReviewEnvelope>;
  deriveOrdinaryExecutionDescriptor(input: unknown): Promise<AuthoritativeOrdinaryExecutionDescriptor>;
  deriveQemuExecutionDescriptor(input: unknown): Promise<AuthoritativeQemuExecutionDescriptor>;
  currentOrdinaryTerminalEvidence(input: CurrentOrdinaryTerminalEvidenceSelector): Promise<CurrentOrdinaryTerminalEvidence>;
  close(): Promise<void>;
};

export class NativeGitBundleServerError extends Error {
  readonly name = "NativeGitBundleServerError";
}
