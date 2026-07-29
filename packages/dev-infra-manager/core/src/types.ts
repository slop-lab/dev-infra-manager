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
