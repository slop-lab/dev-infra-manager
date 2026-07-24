export interface ManagedGitHostConfig {
  kind: "bare-git-pr";
  remote: string;
  protectedRefs: string[];
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
  managedGitHost: ManagedGitHostConfig;
  secretRuntime: SecretRuntimeConfig;
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
