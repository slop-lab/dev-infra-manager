import {
  UserError, type WorkspaceRecord, type WorkspaceService, type WorkspaceSourceCreateInput,
  type WorkspaceSourceProviderContext, type WorkspaceRuntimeFactoryContext
} from "@slop-lab/dim-host-core/workspace";
import { hostPluginExtensions, loadHostPlugins } from "./host-plugins.js";

export type WorkspaceHostCreateInput = WorkspaceSourceCreateInput;
export type WorkspaceHostContext = Omit<WorkspaceSourceProviderContext, "stateRoot">;

const gitSchemes = new Set(["http", "https", "ssh", "git", "file", "git+ssh", "ssh+git"]);
function sourceScheme(url: string): string | undefined {
  return /^([a-z][a-z0-9+.-]*):\/\//i.exec(url)?.[1]?.toLowerCase();
}
function isOrdinaryGit(url: string): boolean {
  const scheme = sourceScheme(url);
  return scheme === undefined || gitSchemes.has(scheme);
}

async function sourceProvider(url: string) {
  const scheme = sourceScheme(url);
  const plugins = await loadHostPlugins();
  const providers = plugins.filter(({ source }) => scheme !== undefined && source?.schemes.includes(scheme));
  if (providers.length > 1) throw new UserError(`multiple enabled host plugins own source scheme '${scheme}'`);
  const provider = providers[0]?.source;
  if (!provider) throw new UserError(`source scheme '${scheme ?? "unknown"}' has no enabled host provider; install and enable its host plugin`);
  return { provider, extensions: hostPluginExtensions(plugins) };
}

/** Source acquisition belongs to the explicitly enabled owner of a non-Git source scheme. */
export async function createWorkspaceOnHost(
  input: WorkspaceHostCreateInput, service: Pick<WorkspaceService, "create">, context: WorkspaceHostContext
): Promise<WorkspaceRecord> {
  if (isOrdinaryGit(input.source.url)) {
    if (input.repositories !== undefined || input.workingDirectory !== undefined) {
      throw new UserError("--repository and --workdir require a source provider that supports repository selection");
    }
    return service.create(input);
  }
  const { provider, extensions } = await sourceProvider(input.source.url);
  return provider.create(input, { ...context, stateRoot: context.store.root, extensions });
}

/** Reapply the enabled source integration after host reboot or runtime replacement. */
export async function ensureWorkspaceIntegration(record: WorkspaceRecord, context: WorkspaceHostContext): Promise<void> {
  if (record.initialized && record.phase === "running" && !isOrdinaryGit(record.source.url)) {
    const { provider, extensions } = await sourceProvider(record.source.url);
    await provider.ensure?.(record, { ...context, stateRoot: context.store.root, extensions });
  }
}

/** Metadata remains optional; the generic controller never loads a feature by package presence. */
export async function resolveWorkspaceMetadata(record: WorkspaceRecord, context: WorkspaceRuntimeFactoryContext): Promise<{
  projectId: string; projectName: string;
} | undefined> {
  let selected: { projectId: string; projectName: string } | undefined;
  const plugins = await loadHostPlugins(), extensions = hostPluginExtensions(plugins);
  for (const plugin of plugins) {
    const metadata = await plugin.workspaceMetadata?.(record, { ...context, extensions });
    if (metadata === undefined) continue;
    if (selected) throw new UserError(`multiple enabled host plugins supplied metadata for workspace '${record.name}'`);
    selected = metadata;
  }
  return selected;
}
