export type NativeFixture = {
  readonly stateRoot: string;
  readonly serviceRoot: string;
  readonly sourceRepository: string;
  readonly registrarPath: string;
  readonly importerPath: string;
  readonly controlPath: string;
  readonly commit: string;
  readonly tree: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly advanceLeaseClock: (milliseconds: number) => void;
  readonly leaseClock: () => number;
  readonly readinessRequests: () => number;
  readonly restartNativeGit: () => Promise<void>;
  readonly rolloverNativeGit: (publishConnection?: boolean) => Promise<void>;
  readonly publishCurrentGeneration: () => Promise<void>;
  readonly importGenerationId: string;
  readonly currentGenerationId: string;
};

export type NativeFixtureOptions = {
  readonly seedImportedDraft?: boolean;
  readonly workspaceWriteLeaseClock?: () => number;
};
