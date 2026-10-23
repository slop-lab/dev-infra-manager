import { UserError } from "../../workspace.js";

/** Operator composition is optional on the selected host, separate from its server runtime. */
export async function runControlPlaneApplication(args: string[]): Promise<void> {
  try { import.meta.resolve("@slop-lab/dim-control-plane-admin/cli"); }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ERR_MODULE_NOT_FOUND") {
      throw new UserError("Control-plane administration is not installed on this host. Run 'dim installer install core --with-managed' to add the native Git/CI administration profile.");
    }
    throw error;
  }
  const module: unknown = await import(import.meta.resolve("@slop-lab/dim-control-plane-admin/cli"));
  if (!module || typeof module !== "object" || !("runControlPlaneAdminCli" in module) || typeof module.runControlPlaneAdminCli !== "function") throw new UserError("Invalid control-plane administration entrypoint");
  const runControlPlaneAdminCli = module.runControlPlaneAdminCli as (args: string[]) => Promise<void>;
  await runControlPlaneAdminCli(args);
}
