import { UserError } from "@slop-lab/dim-core/workspace";

/** Optional composition runs on the selected host, never in workspace code. */
export async function runManagedApplication(args: string[]): Promise<void> {
  try {
    import.meta.resolve("@slop-lab/dim-managed/cli");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ERR_MODULE_NOT_FOUND") {
      throw new UserError("Managed administration is not installed on this host. Run 'dim installer install core --with-managed' to add it.");
    }
    throw error;
  }
  const { runManagedCli } = await import("@slop-lab/dim-managed/cli");
  await runManagedCli(args);
}
