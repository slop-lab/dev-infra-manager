import type { NativeGitBundleState } from "./native-bundle-state.js";
import type { NativeProjectRegistration } from "./native-project-registry-state.js";
import type { NativeProjectRootImportInstalled } from "./native-project-root-import-codec.js";
import type { GitExecutableIdentity } from "./repository.js";

type AttestationEntry = {
  readonly authority: string;
  readonly storage: string;
  readonly proof: Promise<void>;
};

const attestations = new WeakMap<NativeGitBundleState, Map<string, AttestationEntry>>();

type ImmutableNativeRootAttestationInput = {
  readonly state: NativeGitBundleState;
  readonly repository: string;
  readonly authority: string;
  readonly storage: string;
  readonly prove: () => Promise<void>;
};

export async function attestImmutableNativeRoot(input: ImmutableNativeRootAttestationInput): Promise<boolean> {
  const stateAttestations = attestations.get(input.state) ?? new Map<string, AttestationEntry>();
  attestations.set(input.state, stateAttestations);
  const existing = stateAttestations.get(input.repository);
  if (existing?.authority === input.authority && existing.storage === input.storage) {
    await existing.proof;
    return false;
  }
  let entry: AttestationEntry;
  const proof = input.prove().catch((error: unknown) => {
    if (stateAttestations.get(input.repository) === entry) stateAttestations.delete(input.repository);
    throw error;
  });
  entry = { authority: input.authority, storage: input.storage, proof };
  stateAttestations.set(input.repository, entry);
  await proof;
  return true;
}

export async function immutableNativeRootAttestationIsCurrent(
  input: Omit<ImmutableNativeRootAttestationInput, "prove">
): Promise<boolean> {
  const stateAttestations = attestations.get(input.state);
  const entry = stateAttestations?.get(input.repository);
  if (entry?.authority !== input.authority || entry.storage !== input.storage) return false;
  await entry.proof;
  return stateAttestations?.get(input.repository) === entry;
}

export function nativeRootImmutableAuthorityIdentity(input: {
  readonly ownerHostId: string;
  readonly registration: NativeProjectRegistration;
  readonly imported: NativeProjectRootImportInstalled;
  readonly gitExecutable: string;
  readonly gitIdentity: GitExecutableIdentity;
}): string {
  return JSON.stringify({
    ownerHostId: input.ownerHostId,
    registration: input.registration,
    imported: input.imported,
    gitExecutable: input.gitExecutable,
    gitIdentity: Object.fromEntries(Object.entries(input.gitIdentity).map(([name, value]) => [name, String(value)]))
  });
}
