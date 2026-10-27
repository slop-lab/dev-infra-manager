import { Writable } from "node:stream";
import { UserError, type WorkspaceRecord } from "@slop-lab/dim-host-core/workspace";
import type { WorkspaceCapabilityFact, WorkspaceHostPluginContext } from "@slop-lab/dim-host-core/plugin-api";

const guestProbe = `import os,sys,stat,fcntl,json
result={'state':'verification-failed'}
try:
 info=os.stat('/dev/kvm',follow_symlinks=False)
 if not stat.S_ISCHR(info.st_mode) or os.major(info.st_rdev)!=10 or os.minor(info.st_rdev)!=232:
  result={'state':'device-identity-invalid'}
 else:
  fd=os.open('/dev/kvm',os.O_RDWR|os.O_CLOEXEC|os.O_NOFOLLOW)
  try:
   version=fcntl.ioctl(fd,0xae00,0)
   if version==12:
    result={'state':'available','apiVersion':12}
    if sys.argv[1]=='verify':
     vm=fcntl.ioctl(fd,0xae01,0)
     os.close(vm)
     result['effect']='vm-fd-created-and-closed'
   else: result={'state':'kvm-api-unavailable'}
  finally: os.close(fd)
except FileNotFoundError: result={'state':'device-missing'}
except PermissionError: result={'state':'permission-denied'}
except OSError: result={'state':'kvm-api-unavailable'}
print(json.dumps(result))`;

const messages = {
  "runtime-grant-required": "This workspace has no KVM runtime grant. Ask the operator for a separate verification workspace created with --runtime container-kvm; do not alter this workspace or infer host availability.",
  "device-missing": "The selected KVM runtime has no guest device. The operator must inspect the granted runtime/device attachment; host KVM availability is not inferred.",
  "device-identity-invalid": "The guest device is not the expected KVM character device.",
  "permission-denied": "The guest KVM device is present but cannot be opened with the workspace's current permissions.",
  "python-unavailable": "Python 3 is required inside this workspace for the fixed KVM verification probe.",
  "kvm-api-unavailable": "The guest KVM API cannot be used; device presence alone is not a usable VM path.",
  "verification-failed": "The bounded guest KVM probe did not return valid verification evidence.",
  "probe-unreachable": "The current workspace runtime could not complete the bounded guest KVM probe."
} as const;
type BlockedReason = keyof typeof messages;
type ProbeResult = { readonly state: "available" } | { readonly state: "unavailable"; readonly reason: BlockedReason };
const probing = new Set<string>();

export async function kvmWorkspaceCapabilities(workspace: WorkspaceRecord, context: WorkspaceHostPluginContext): Promise<readonly WorkspaceCapabilityFact[]> {
  const result: ProbeResult = workspace.runtime === "container-kvm" ? await probe(workspace, context, "access") : { state: "unavailable", reason: "runtime-grant-required" };
  const descriptions = [
    { name: "direct-access", description: "Explicit guest KVM device and API access for repository-owned VM tooling", access: { kind: "workspace-local" as const } },
    { name: "vm-fd-verification", description: "Create and close one KVM VM descriptor inside this workspace; does not boot a guest OS or run a repository suite", access: { kind: "guest-operation" as const, operation: "verify" } }
  ];
  return descriptions.map((entry) => result.state === "available" ? { ...entry, state: "available" } : {
    ...entry, state: result.reason === "runtime-grant-required" ? "blocked" : "unavailable", access: { kind: "none" },
    reason: { code: result.reason, message: messages[result.reason] }
  });
}

export async function verifyWorkspaceKvm(input: unknown, workspace: WorkspaceRecord, context: WorkspaceHostPluginContext): Promise<unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length > 0) throw new UserError("KVM verification accepts only an empty object and no selectors or commands");
  if (workspace.runtime !== "container-kvm") throw new UserError(messages["runtime-grant-required"]);
  const key = `${context.stateRoot}:${workspace.id}`;
  if (probing.has(key)) throw new UserError("A KVM verification is already in progress for this workspace");
  probing.add(key);
  try {
    return await context.store.withLock(workspace.name, async () => {
      const current = await context.store.read(workspace.name);
      if (current.id !== workspace.id || current.runtime !== "container-kvm" || !current.initialized || current.phase !== "running") throw new UserError("KVM verification workspace identity, runtime or lifecycle changed");
      const result = await probe(current, context, "verify");
      if (result.state !== "available") return { schemaVersion: 1, workspaceId: current.id, scope: "workspace-kvm", outcome: "unavailable", reason: { code: result.reason, message: messages[result.reason] } };
      return { schemaVersion: 1, workspaceId: current.id, scope: "workspace-kvm", outcome: "verified", effect: "vm-fd-created-and-closed", kvmApiVersion: 12, verifiedAt: new Date().toISOString() };
    });
  } finally { probing.delete(key); }
}

async function probe(workspace: WorkspaceRecord, context: WorkspaceHostPluginContext, mode: "access" | "verify"): Promise<ProbeResult> {
  let output = "", overflow = false;
  const stdout = new Writable({ write(chunk: Buffer, _encoding, done) { if (output.length + chunk.length > 4096) overflow = true; else output += chunk.toString("utf8"); done(); } });
  const stderr = new Writable({ write(_chunk, _encoding, done) { done(); } });
  try {
    const exit = await context.service.exec(workspace.name, ["python3", "-c", guestProbe, mode], { workspaceId: workspace.id, stdout, stderr, signal: AbortSignal.any([context.signal, AbortSignal.timeout(5000)]) });
    if (exit === 127) return { state: "unavailable", reason: "python-unavailable" };
    if (exit !== 0 || overflow) return { state: "unavailable", reason: "verification-failed" };
    const value: unknown = JSON.parse(output);
    if (value && typeof value === "object" && "state" in value) {
      if (value.state === "available" && "apiVersion" in value && value.apiVersion === 12 && (mode === "access" || "effect" in value && value.effect === "vm-fd-created-and-closed")) return { state: "available" };
      if (blockedReason(value.state)) return { state: "unavailable", reason: value.state };
    }
    return { state: "unavailable", reason: "verification-failed" };
  } catch (error) {
    if (error instanceof SyntaxError) return { state: "unavailable", reason: "verification-failed" };
    if (!(error instanceof Error)) throw error;
    return { state: "unavailable", reason: "probe-unreachable" };
  } finally { stdout.destroy(); stderr.destroy(); }
}
function blockedReason(value: unknown): value is BlockedReason { return typeof value === "string" && Object.hasOwn(messages, value); }
