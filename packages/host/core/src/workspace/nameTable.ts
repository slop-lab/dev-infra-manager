import { UserError } from "../errors.js";
import { validateNameRegistration, type WorkspaceNameRegistration } from "./nameRegistration.js";

/** Per-workspace names, namespaced by the registering plugin. Reconciled as a complete set per owner. */
export type WorkspaceNameTable = Readonly<Record<string, readonly WorkspaceNameRegistration[]>>;
const OWNER = /^[a-z][a-z0-9-]{0,63}$/;

/** Replaces `owner`'s contribution wholesale; idempotent; an empty set removes the owner's entry. */
export function reconcileNameTable(table: WorkspaceNameTable, owner: string, registrations: readonly WorkspaceNameRegistration[]): WorkspaceNameTable {
  if (!OWNER.test(owner)) throw new UserError(`invalid workspace name owner '${owner}'`);
  if (registrations.length > 256) throw new UserError("too many workspace name registrations");
  const validated = registrations.map(validateNameRegistration);
  const names = new Set<string>();
  for (const { name } of validated) {
    if (names.has(name)) throw new UserError(`duplicate workspace internal name '${name}'`);
    names.add(name);
  }
  for (const [other, entries] of Object.entries(table)) {
    if (other === owner) continue;
    for (const { name } of entries) if (names.has(name)) throw new UserError(`workspace internal name '${name}' is already registered by '${other}'`);
  }
  const next = { ...table };
  if (validated.length === 0) delete next[owner]; else next[owner] = validated;
  return next;
}

export function flattenNameTable(table: WorkspaceNameTable): ReadonlyMap<string, string> {
  const result = new Map<string, string>();
  for (const entries of Object.values(table)) for (const { name, upstream } of entries) result.set(name, upstream);
  return result;
}

export function parseNameTable(value: unknown): WorkspaceNameTable {
  if (value === undefined) return {};
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new UserError("invalid workspace name table");
  const result: Record<string, readonly WorkspaceNameRegistration[]> = {};
  for (const [owner, entries] of Object.entries(value as Record<string, unknown>)) {
    if (!OWNER.test(owner) || !Array.isArray(entries)) throw new UserError("invalid workspace name table");
    result[owner] = entries.map((entry) => validateNameRegistration(parseRegistration(entry)));
  }
  return result;
}

function parseRegistration(value: unknown): WorkspaceNameRegistration {
  if (typeof value !== "object" || value === null || typeof (value as Record<string, unknown>).name !== "string" || typeof (value as Record<string, unknown>).upstream !== "string") {
    throw new UserError("invalid workspace name registration");
  }
  return { name: (value as Record<string, unknown>).name as string, upstream: (value as Record<string, unknown>).upstream as string };
}
