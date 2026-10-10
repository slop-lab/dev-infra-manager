import { isDeepStrictEqual } from "node:util";
import { currentAuthoritativeOrdinaryTerminal } from "./authoritative-ordinary-current.js";
import type { AuthoritativeNativeCandidateRuntime } from "./authoritative-native-root-target.js";
import type { NativeGitBundleConfig } from "./bundle-config.js";
import type {
  CurrentOrdinaryTerminalEvidence,
  CurrentOrdinaryTerminalEvidenceSelector
} from "./native-bundle-server-types.js";
import type { AdmissionVerifierHttpClient } from "./ordinary-admission-http.js";
import { verifyOrdinaryCurrentTerminal } from "./ordinary-current-terminal-proof.js";

type CurrentOrdinaryTerminalEvidenceContext = {
  readonly config: NativeGitBundleConfig["ordinaryCi"];
  readonly httpClient: AdmissionVerifierHttpClient;
  readonly runtime: AuthoritativeNativeCandidateRuntime;
  readonly serialize: <Result>(operation: () => Promise<Result>) => Promise<Result>;
};

export async function currentOrdinaryTerminalEvidence(
  context: CurrentOrdinaryTerminalEvidenceContext,
  input: CurrentOrdinaryTerminalEvidenceSelector
): Promise<CurrentOrdinaryTerminalEvidence> {
  const before = await context.serialize(() => currentAuthoritativeOrdinaryTerminal(
    context.runtime,
    input,
    context.config.resultReporter.username
  ));
  const provenance = await verifyOrdinaryCurrentTerminal({
    config: context.config,
    generationId: context.runtime.expectedGenerationId,
    httpClient: context.httpClient,
    projectId: before.selector.projectId,
    root: before.target.currentHead,
    event: before.terminal.event,
    status: before.terminal.status,
    statusJson: before.terminal.serialized
  });
  return context.serialize(async () => {
    const after = await currentAuthoritativeOrdinaryTerminal(
      context.runtime,
      input,
      context.config.resultReporter.username
    );
    if (!isDeepStrictEqual(after, before)) throw new CurrentOrdinaryTerminalEvidenceChangedError();
    const event = after.terminal.event;
    return {
      schemaVersion: 1,
      executionKind: "ordinary-sysbox",
      evidenceClass: "candidate-controlled",
      projectId: after.selector.projectId,
      repositoryId: "root",
      reviewId: after.selector.reviewId,
      jobName: after.selector.jobName,
      attemptId: event.payload.attemptId,
      attempt: event.payload.attempt,
      descriptorDigest: event.payload.descriptorDigest,
      hostId: event.payload.hostId,
      capacity: event.payload.capacity,
      result: event.payload.result,
      completion: event.payload.completion,
      terminalEvent: event,
      provenance
    };
  });
}

class CurrentOrdinaryTerminalEvidenceChangedError extends Error {
  readonly name = "CurrentOrdinaryTerminalEvidenceChangedError";
  constructor() { super("ordinary terminal evidence changed during proof"); }
}
