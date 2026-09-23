import { AdmissionError } from "./errors.js";
import type { AdmittedWorkload, ApprovalAuthority } from "./approval.js";
import type { BrokerPollRequest, ScheduleProposal } from "./protocol.js";

export type WorkloadResult = { readonly exitCode: number };
export type ApprovedWorkload = (admission: AdmittedWorkload) => Promise<WorkloadResult>;

export interface BrokerTransport {
  poll(request: BrokerPollRequest): Promise<ScheduleProposal>;
}

export interface WorkloadExecutor {
  execute(admission: AdmittedWorkload): Promise<WorkloadResult>;
}

export class WorkloadRegistryExecutor implements WorkloadExecutor {
  constructor(readonly workloads: ReadonlyMap<string, ApprovedWorkload>) {}

  async execute(admission: AdmittedWorkload): Promise<WorkloadResult> {
    const workload = this.workloads.get(admission.workloadId);
    if (workload === undefined) {
      throw new AdmissionError(`workload ID '${admission.workloadId}' is not registered by the local operator`);
    }
    return await workload(admission);
  }
}

export async function executeRemoteProposal(
  transport: BrokerTransport,
  authority: ApprovalAuthority,
  executor: WorkloadExecutor,
  request: BrokerPollRequest
): Promise<WorkloadResult> {
  const proposal = await transport.poll(request);
  if (proposal.requestId !== request.requestId || proposal.projectId !== request.projectId) {
    throw new AdmissionError("broker response identity does not match the bounded poll request");
  }
  return await executor.execute(await authority.admit(proposal));
}
