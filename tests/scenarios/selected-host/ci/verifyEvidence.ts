import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { requirePracticalReport } from "./requiredReport.ts";
import { requireIncusForwarding } from "./fixtureNetwork.ts";
import { baselineRecipeDigest, parseBaselineManifest } from "../../../../scripts/checks/vm-baseline.ts";

const [root, sourceSha, sourceTree] = process.argv.slice(2);
if (!root?.startsWith("/") || !sourceSha || !/^[a-f0-9]{40}$/.test(sourceSha) || !sourceTree || !/^[a-f0-9]{40}$/.test(sourceTree)) throw new Error("absolute evidence root and exact source commit/tree required");
const roles = await readFile(join(root, "roles.txt"), "utf8"), cp = /^control-plane-machine=([a-f0-9]{32})$/m.exec(roles)?.[1], host = /^workspace-host-machine=([a-f0-9]{32})$/m.exec(roles)?.[1];
if (!cp || !host || cp === host) throw new Error("required CP and host evidence does not identify separate VMs");
const input = await readFile(join(root, "input.txt"), "utf8"), installationMode = /^installation-mode=(cold|dependency-baseline)$/m.exec(input)?.[1];
if (!installationMode) throw new Error("practical qualification must identify cold or cached dependency installation");
const baseline = installationMode === "dependency-baseline" ? parseBaselineManifest(JSON.parse(await readFile(join(root, "dependency-baseline.json"), "utf8"))) : undefined;
if (baseline && baseline.recipeSha256 !== await baselineRecipeDigest(resolve(import.meta.dirname, "../../../.."))) throw new Error("qualification baseline recipe differs from the exact current source/toolchain");
const identities = JSON.parse(await readFile(join(root, "clone-identities.json"), "utf8")) as {
  controlPlane?: { machine?: string; instanceId?: string; sshHostKey?: string };
  host?: { machine?: string; instanceId?: string; sshHostKey?: string };
};
if (identities.controlPlane?.machine !== cp || identities.host?.machine !== host
  || !identities.controlPlane.instanceId || !identities.host.instanceId || identities.controlPlane.instanceId === identities.host.instanceId
  || !identities.controlPlane.sshHostKey?.startsWith("SHA256:") || !identities.host.sshHostKey?.startsWith("SHA256:")
  || identities.controlPlane.sshHostKey === identities.host.sshHostKey) throw new Error("practical qualification is missing independent guest-observed clone identities");
const value: unknown = JSON.parse(await readFile(join(root, "practical-runtime.json"), "utf8"));
if (!value || typeof value !== "object" || !("sourceSha" in value) || value.sourceSha !== sourceSha || !("sourceTree" in value) || value.sourceTree !== sourceTree
  || !("status" in value) || value.status !== "PASS" || !("image" in value) || typeof value.image !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value.image)
  || !("artifactManifestSha256" in value) || typeof value.artifactManifestSha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.artifactManifestSha256)
  || !("providerFixture" in value) || typeof value.providerFixture !== "string" || !value.providerFixture.startsWith("TEST-ONLY") || !("report" in value)) throw new Error("required practical receipt is absent, stale or misqualified");
requirePracticalReport(value.report, sourceSha, value.image);
if (!("artifacts" in value) || !value.artifacts || typeof value.artifacts !== "object" || !("after" in value.artifacts) || !("before" in value.artifacts)) throw new Error("required exact artifact closures are missing");
for (const binding of [value.artifacts.before, value.artifacts.after]) {
  if (!binding || typeof binding !== "object" || !("closureSha256" in binding) || typeof binding.closureSha256 !== "string" || !/^[a-f0-9]{64}$/.test(binding.closureSha256)
    || !("packageCount" in binding) || binding.packageCount !== 74) throw new Error("required complete artifact closure is malformed");
}
if (!("incus" in value) || !value.incus || typeof value.incus !== "object" || !("hostMachineId" in value.incus) || value.incus.hostMachineId !== host
   || !("imageType" in value.incus) || value.incus.imageType !== "virtual-machine" || !("kvmProbe" in value.incus) || value.incus.kvmProbe !== "KVM_CREATE_VM") throw new Error("required Incus preparation is not tied to the actual host VM");
if (!("forwarding" in value.incus) || !("forwardingCleanup" in value) || value.forwardingCleanup !== "exact-owned-rules-removed") throw new Error("owned Incus forwarding or cleanup receipt is missing");
const forwarding = requireIncusForwarding(value.incus.forwarding, { machine: host, sourceSha });
if (forwarding.inserted.length !== 2) throw new Error("complete owned Incus forwarding preparation is missing");
await writeFile(join(root, "qualification.json"), JSON.stringify({ schemaVersion: 1, status: "PASS", sourceSha, sourceTree, installationMode,
  ...(baseline ? { baselineRecipeSha256: baseline.recipeSha256 } : {}), nestedCiImagePreparation: "cold", identities }, null, 2) + "\n", { mode: 0o600 });
console.log(`PASS required practical CI receipt for exact source=${sourceSha} installation=${installationMode}; deterministic protocol/tool fixture, external provider qualification NOT ASSESSED`);
