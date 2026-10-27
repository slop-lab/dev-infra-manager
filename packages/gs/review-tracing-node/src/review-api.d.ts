declare module "dim:review" {
  /** Exact changed-path metadata supplied to matches(changes). */
  export interface ReviewChange {
    readonly status: string;
    readonly oldPath?: string | undefined;
    readonly newPath?: string | undefined;
    readonly oldPathBytes: string;
    readonly newPathBytes: string;
  }
  /** Read repository helper code/configuration as a protected dependency. */
  export function readText(path: string): Promise<string | undefined>;
  /** Read detector input without making the whole file a protected dependency. */
  export function readTarget(path: string, view?: "before" | "after"): Promise<string | undefined>;
}
