/** Validate paths inside the materialized candidate without assuming a workflow language. */
export function isCandidatePath(value: string): boolean {
  return value.length > 0 && value.length <= 4096 && !value.startsWith("/")
    && !/[\\\x00-\x1f\x7f]/.test(value)
    && value.split("/").every((part) => part.length > 0 && part !== "." && part !== ".." && part !== ".git");
}
