import { randomUUID } from "node:crypto";
import type { NativeRootAdmission } from "./nativeRootAdmissionModel.js";
import { createNodeNativeGitAdmissionHttpClient } from "./nativeGitAdmissionHttpClient.js";
import type { NativeGitAdmissionHttpClient } from "./nativeGitAdmissionSource.js";
import { loadNativeRootCiAdmissionConfig } from "./nativeRootCiHostConfig.js";
import { exactRecord, NativeRootCiHostClientError, sendGet, sendJson } from "./nativeRootCiHostClientWire.js";
import { parseNativeRootCiPolicyProof } from "./nativeRootCiProofModel.js";

const projectPattern = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const digestPattern = /^[0-9a-f]{64}$/;

export type NativeRootCiAdmissionResponse = {
  readonly schemaVersion: 1;
  readonly serviceId: "ordinary-main";
  readonly requestId: string;
  readonly servingGenerationId: string;
  readonly admission: NativeRootAdmission;
};

export async function admitNativeRootCiProject(
  projectId: string,
  configPath: string,
  signal: AbortSignal = AbortSignal.timeout(10_000),
  client: NativeGitAdmissionHttpClient = createNodeNativeGitAdmissionHttpClient()
): Promise<NativeRootCiAdmissionResponse> {
  if (!projectPattern.test(projectId)) invalid();
  const config = await loadNativeRootCiAdmissionConfig(configPath);
  const authorization = `Basic ${Buffer.from(`${config.ordinaryCi.registrar.username}:${config.ordinaryCi.registrar.password}`,
    "utf8").toString("base64")}`;
  const identity = exactRecord(await sendGet(client, config.ordinaryCi.endpoint, authorization,
    "/v1/native-root-admission/identity", signal),
  ["schemaVersion", "serviceId", "servingGenerationId", "role", "scope"]);
  if (identity.schemaVersion !== 1 || identity.serviceId !== "ordinary-main"
    || identity.servingGenerationId !== config.generationId
    || identity.role !== "native-root-admission-registrar"
    || JSON.stringify(identity.scope) !== JSON.stringify(["imported-root-admission:write", "imported-root-admission:revoke"])) invalid();
  const requestId = randomUUID();
  const response = await sendJson(client, config.ordinaryCi.endpoint, authorization,
    `/v1/projects/${projectId}/repositories/root/native-root-admission/register`,
    JSON.stringify({ schemaVersion: 1, requestId, generationId: config.generationId }), signal, [200]);
  return parseResponse(response.body, projectId, requestId, config.generationId);
}

function parseResponse(value: unknown, projectId: string, requestId: string,
  generationId: string): NativeRootCiAdmissionResponse {
  const response = exactRecord(value,
    ["schemaVersion", "serviceId", "requestId", "servingGenerationId", "admission"]);
  if (response.schemaVersion !== 1 || response.serviceId !== "ordinary-main"
    || response.requestId !== requestId || response.servingGenerationId !== generationId) invalid();
  const admission = exactRecord(response.admission,
    ["schemaVersion", "admissionGeneration", "capacityConfigDigest", "expiresAt", "importedRoot"]);
  if (admission.schemaVersion !== 1 || typeof admission.admissionGeneration !== "string"
    || !uuidPattern.test(admission.admissionGeneration) || typeof admission.capacityConfigDigest !== "string"
    || !digestPattern.test(admission.capacityConfigDigest) || typeof admission.expiresAt !== "number"
    || !Number.isSafeInteger(admission.expiresAt) || admission.expiresAt < 1) invalid();
  const imported = exactRecord(admission.importedRoot,
    ["serviceId", "servingGenerationId", "projectId", "repositoryId", "currentRoot", "policy"]);
  const proof = parseNativeRootCiPolicyProof({ schemaVersion: 1, requestId, ...imported }, {
    serviceId: "native-main", generationId, requestId, projectId
  });
  return { schemaVersion: 1, serviceId: "ordinary-main", requestId,
    servingGenerationId: generationId, admission: { schemaVersion: 1,
      admissionGeneration: admission.admissionGeneration,
      capacityConfigDigest: admission.capacityConfigDigest, expiresAt: admission.expiresAt,
      importedRoot: { serviceId: "native-main", servingGenerationId: proof.servingGenerationId,
        projectId: proof.projectId, repositoryId: "root", currentRoot: proof.currentRoot, policy: proof.policy } } };
}

function invalid(): never {
  throw new NativeRootCiHostClientError("native root CI admission response or scope is invalid");
}
