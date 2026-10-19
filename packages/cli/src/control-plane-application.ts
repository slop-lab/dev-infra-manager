import { UserError } from "@slop-lab/dim-host-core/workspace";

/** Operator composition is optional on the selected host, separate from its server runtime. */
export async function runControlPlaneApplication(args: string[]): Promise<void> {
  try { import.meta.resolve("@slop-lab/dim-control-plane-admin/cli"); }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ERR_MODULE_NOT_FOUND") {
      throw new UserError("Control-plane administration is not installed on this host. Run 'dim installer install core --with-managed' to add the native Git/CI administration profile.");
    }
    throw error;
  }
  const { runControlPlaneAdminCli } = await import("@slop-lab/dim-control-plane-admin/cli");
  await runControlPlaneAdminCli(args);
}
