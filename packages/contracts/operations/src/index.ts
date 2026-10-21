export type OperationAccess = "read" | "operator" | "reviewer";
export interface Operation<I = unknown, O = unknown> {
  readonly name: string; readonly description: string; readonly access: OperationAccess;
  parseInput(value: unknown): I; parseOutput(value: unknown): O;
}
export interface OperationDescriptor { name: string; description: string; access: OperationAccess }
export function operationDescriptors(operations: readonly Operation[]): OperationDescriptor[] {
  const names = new Set<string>();
  return operations.map(({ name, description, access, parseInput, parseOutput }) => {
    if (!/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/.test(name) || names.has(name) || typeof parseInput !== "function" || typeof parseOutput !== "function" || !description.trim() || !["read", "operator", "reviewer"].includes(access)) throw new Error("invalid or duplicate operation description");
    names.add(name); return { name, description, access };
  });
}
