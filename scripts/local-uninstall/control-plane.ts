import { join } from "node:path";
import { isIP } from "node:net";
import { object, readJson, text, uuid } from "./files.ts";
import type { DockerClaim } from "./types.ts";

type Ownership = { deploymentId: string; generationId: string; service: "execution" | "ordinary-ci" };
const digest = /^sha256:[0-9a-f]{64}$/;
const generation = /^[0-9a-f]{64}$/;
const image = /^[a-z0-9][a-z0-9./:_-]*@sha256:[0-9a-f]{64}$/;

/** Labels are ownership assertions to verify against Docker, never discovery-by-name authorization. */
export async function collectControlPlaneClaims(root: string): Promise<DockerClaim[]> {
  const installed = await readJson(join(root, "install.json"));
  const transaction = await readJson(join(root, "transaction.json"));
  if (installed === undefined) {
    if (transaction !== undefined) throw new Error("control-plane transaction lacks an installed ownership record");
    return [];
  }
  const current = ownership(installed);
  const owners = [current];
  if (transaction !== undefined) {
    const journal = object(transaction);
    exact(journal, ["schemaVersion", "transactionId", "phase", "candidateGenerationId", "stagingDirectory", "prior"]);
    const id = uuid(journal.transactionId);
    if (journal.schemaVersion !== 1 || journal.phase !== "publishing"
      || journal.stagingDirectory !== `.staging-${id}` || journal.candidateGenerationId !== current.generationId) {
      throw new Error("unrecognized control-plane transaction ownership");
    }
    if (journal.prior !== null) {
      const prior = object(journal.prior);
      exact(prior, ["generationId", "installBase64", "composeBase64"]);
      const record = ownership(JSON.parse(canonicalBase64(prior.installBase64, 64 * 1024).toString("utf8")) as unknown);
      canonicalBase64(prior.composeBase64, 1024 * 1024);
      if (record.generationId !== prior.generationId || record.deploymentId !== current.deploymentId) {
        throw new Error("control-plane transaction changes deployment ownership");
      }
      owners.push(record);
    }
  }
  const claims = owners.flatMap(claimsFor);
  return [...new Map(claims.map((claim) => [`${claim.kind}:${claim.name}`, claim])).values()];
}

function ownership(input: unknown): Ownership {
  const record = object(input);
  const execution = Object.hasOwn(record, "executionImage");
  const ordinary = Object.hasOwn(record, "ordinaryCiImage");
  if (execution === ordinary) throw new Error("unknown control-plane service layout");
  const prefix = execution ? "execution" : "ordinaryCi";
  const keys = ["schemaVersion", "deploymentId", "generationId", "composeSha256", "nativeGitImage", `${prefix}Image`,
    "nativeGitPublish", `${prefix}Publish`, "nativeGitConfigSha256", "nativeGitReadinessTokenSha256",
    `${prefix}ConfigSha256`, `${prefix}ReadinessTokenSha256`, "nativeGitActivationTokenSha256", `${prefix}ActivationTokenSha256`, "volumesEstablished"];
  exact(record, keys);
  const deploymentId = text(record.deploymentId), generationId = text(record.generationId);
  if (record.schemaVersion !== 1 || record.volumesEstablished !== true
    || !/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(deploymentId) || !generation.test(generationId)
    || !image.test(text(record.nativeGitImage)) || !image.test(text(record[`${prefix}Image`]))) {
    throw new Error("invalid control-plane installed ownership record");
  }
  for (const key of keys.filter((name) => name.endsWith("Sha256"))) {
    if (!digest.test(text(record[key]))) throw new Error("invalid control-plane snapshot digest");
  }
  for (const key of ["nativeGitPublish", `${prefix}Publish`]) {
    const publish = object(record[key]);
    exact(publish, ["host", "port"]);
    if (isIP(text(publish.host)) === 0 || typeof publish.port !== "number"
      || !Number.isInteger(publish.port) || publish.port < 1 || publish.port > 65535) throw new Error("invalid control-plane publication");
  }
  return { deploymentId, generationId, service: execution ? "execution" : "ordinary-ci" };
}

function claimsFor(owner: Ownership): DockerClaim[] {
  const project = "dim-control-plane";
  const labels = (resource: string, service?: string): Record<string, string> => ({
    "org.dim.managed": "true", "org.dim.bundle": "control-plane", "org.dim.deployment": owner.deploymentId,
    "org.dim.resource": resource, "com.docker.compose.project": project,
    ...(service === undefined ? {} : { "org.dim.service": service })
  });
  return [
    { kind: "network", name: project, labels: { ...labels("network"), "com.docker.compose.network": project } },
    ...["native-git", owner.service].flatMap((service): DockerClaim[] => {
      const volume = `dim-control-plane-${service}-data`;
      return [
        { kind: "container", name: `${project}-${service}-1`, labels: { ...labels("service", service),
          "com.docker.compose.service": service, "com.docker.compose.container-number": "1", "com.docker.compose.oneoff": "False" } },
        { kind: "volume", name: volume, labels: { ...labels("volume", service), "com.docker.compose.volume": volume } }
      ];
    })
  ];
}
function exact(value: Record<string, unknown>, keys: readonly string[]): void {
  if (Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) throw new Error("unrecognized control-plane ownership state fields");
}
function canonicalBase64(value: unknown, maximum: number): Buffer {
  const encoded = text(value), bytes = Buffer.from(encoded, "base64");
  if (bytes.length > maximum || bytes.toString("base64") !== encoded) throw new Error("invalid control-plane transaction snapshot");
  return bytes;
}
