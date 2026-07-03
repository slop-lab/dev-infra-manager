export interface ManagedGitHostConfig {
  kind: "bare-git-pr";
  remote: string;
  protectedRefs: string[];
}

export interface ResourceProfile {
  cpuCount: number;
  memoryBytes: number;
  pidsLimit: number;
  diskBytes: number;
  timeoutSeconds: number;
}

export interface AgentConfig {
  image: string;
  runtime: string;
  workspacePath: string;
  runtimeDataPath: string;
  env: Record<string, string>;
  gitEnv: Record<string, string>;
}

export interface SecretRuntimeConfig {
  endpoint: string;
  repo: string;
  approvedRef: string;
  image: string;
  containerName: string;
  contextPath: string;
  dockerfile: string;
  envFile?: string;
  publish: string[];
}

export interface DevInfraConfig {
  stateRoot: string;
  jobMountRoot: string;
  managedGitHost: ManagedGitHostConfig;
  resourceProfiles: Record<string, ResourceProfile>;
  agent: AgentConfig;
  secretRuntime: SecretRuntimeConfig;
}

export interface JobPaths {
  jobRoot: string;
  diskImage: string;
  mountPoint: string;
  workspace: string;
  runtimeData: string;
  metadata: string;
}

export interface JobMetadata {
  jobId: string;
  profileName: string;
  resourceProfile: ResourceProfile;
  paths: JobPaths;
  createdAt: string;
  mounted: boolean;
}

export interface CommandResult {
  command: string;
  args: string[];
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface CommandRunner {
  run(command: string, args: string[], options?: RunOptions): Promise<CommandResult>;
}

export interface StreamingCommandRunner extends CommandRunner {
  runStreaming(command: string, args: string[], options?: RunOptions): Promise<number>;
}

export interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  sudo?: boolean;
}

export interface PlannedCommand {
  command: string;
  args: string[];
  sudo?: boolean;
  allowFailure?: boolean;
}
