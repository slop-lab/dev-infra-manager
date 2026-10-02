import { initialWorkspaceProgress, workspaceProgressStage, type WorkspaceProgressStatus } from "./workspace-progress.js";

type ProgressProfile = {
  readonly initial: WorkspaceProgressStatus;
  readonly stages: Readonly<Record<string, readonly string[]>>;
};

const directProfiles = {
  "image.workspace.build": profile("build context preparation", ["Docker image build"]),
  "image.git-sync.build": profile("build context preparation", ["Docker image build"]),
  "image.qemu-scheduler.build": profile("build context preparation", ["Docker image build"]),
  "repo.import": {
    initial: status("repository preparation", ["source fetch", "managed Git push", "import finalization"]),
    stages: {
      "source fetch": ["managed Git push", "import finalization"],
      "ref materialization": ["managed Git push", "import finalization"],
      "managed Git push": ["import finalization"],
      "import finalization": []
    }
  },
  "repo.fetch": profile("repository preparation", ["synchronization"], {
    "credential lookup": ["synchronization"], synchronization: []
  }),
  "repo.publish": profile("repository preparation", ["synchronization"], {
    "credential lookup": ["synchronization"], synchronization: []
  }),
  "repo.apply": profile("repository set apply", [], { "repository set apply": [] }),
  "project.create": profile("Project creation", [], {
    "manifest discovery": ["Project creation"],
    "root repository import": [],
    "repository set apply": []
  })
} as const satisfies Readonly<Record<string, ProgressProfile>>;

export function initialOperationProgress(operation: string): WorkspaceProgressStatus | undefined {
  return initialWorkspaceProgress(operation) ?? directProfile(operation)?.initial;
}

export function operationProgressStage(operation: string, stage: string): WorkspaceProgressStatus | undefined {
  const workspace = workspaceProgressStage(operation, stage);
  if (workspace !== undefined) return workspace;
  const remaining = directProfile(operation)?.stages[stage];
  return remaining === undefined ? undefined : status(stage, remaining);
}

function directProfile(operation: string): ProgressProfile | undefined {
  return Object.entries(directProfiles).find(([candidate]) => candidate === operation)?.[1];
}

function profile(
  current: string,
  remaining: readonly string[],
  stages: Readonly<Record<string, readonly string[]>> = { "Docker image build": [] }
): ProgressProfile {
  return { initial: status(current, remaining), stages };
}

function status(current: string, remaining: readonly string[]): WorkspaceProgressStatus {
  return { current, remaining };
}
