declare module "dim:review" {
  /** Read repository helper code/configuration as a protected dependency. */
  export function readText(path: string): Promise<string | undefined>;
  /** Read detector input without making the whole file a protected dependency. */
  export function readTarget(path: string, view?: "before" | "after"): Promise<string | undefined>;
}
