export interface RepositorySetEntry {
  url?: string;
  upstream?: string;
  refPrefix?: string;
  fallback: boolean;
  root: boolean;
  ref?: string;
  protectedPatterns: string[];
  forcePushBlockedPatterns: string[];
  importBranches: Record<string, string>;
  publishBranches: Record<string, string>;
}

export interface RepositorySetUpstream {
  url: string;
}

export interface RepositorySet {
  schemaVersion: 1;
  upstreams: Record<string, RepositorySetUpstream>;
  repositories: Record<string, RepositorySetEntry>;
}

export interface RepositoryRefNamespace {
  prefix?: string;
  fallback?: boolean;
  excludedPrefixes?: string[];
  branches?: Record<string, string>;
}

export interface ResolvedRepositoryConnection {
  url: string;
  refNamespace?: RepositoryRefNamespace;
  publishBranches?: Record<string, string>;
}
