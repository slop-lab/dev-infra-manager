import { z } from "zod";
import type { Operation, OperationAccess } from "@slop-lab/dim-contracts-operations";
const id = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/);
const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const nonnegative = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const empty = z.strictObject({});
const projectInput = z.strictObject({ projectId: id });
export const limitsSchema = z.strictObject({ concurrent: positive.max(128), requestsPerUtcDay: positive, requestBytes: positive.max(16 * 1024 * 1024), responseBytes: positive.max(128 * 1024 * 1024), captureBytesPerProject: positive, deadlineMilliseconds: positive.max(3_600_000) });
export const policySchema = z.strictObject({ allowedRoutes: z.array(id).min(1).max(1000), limits: limitsSchema, captureMode: z.enum(["required", "best-effort", "metadata"]), tokenMode: z.enum(["observe", "estimate"]), tokensPerUtcDay: positive.optional(), estimatedTokensPerRequest: positive.optional() }).refine((p) => new Set(p.allowedRoutes).size === p.allowedRoutes.length && (p.tokenMode !== "estimate" || (p.tokensPerUtcDay !== undefined && p.estimatedTokensPerRequest !== undefined)), "invalid route or token admission policy");
export const projectSchema = z.strictObject({ id, enabled: z.boolean(), paused: z.boolean(), revision: z.string(), policy: policySchema });
const model = z.strictObject({ id: z.string().max(200), name: z.string(), api: z.enum(["responses", "chat"]), context: positive, output: positive });
const overview = z.strictObject({ backend: z.strictObject({ name: z.string(), version: z.string(), accountSelection: z.string(), attemptVisibility: z.string(), cancellation: z.string() }), accounts: z.array(z.strictObject({ id, reference: z.string() })), routes: z.array(z.strictObject({ id, accountId: id, models: z.array(model) })), limits: limitsSchema });
const scalar = z.union([z.string(), z.number().finite(), z.boolean(), z.null()]);
const metadata = z.record(z.string(), scalar);
const allowance = z.strictObject({ utcDay: z.string(), enabled: z.boolean(), paused: z.boolean(), booking: z.string(), projectLimits: limitsSchema, serviceLimits: z.union([limitsSchema, z.string()]), admittedRequests: nonnegative, remainingRequests: nonnegative, occupied: nonnegative, serviceOccupied: nonnegative, tokenMode: z.enum(["observe", "estimate"]), tokenLimit: nonnegative.nullable(), chargedTokensOrEstimates: nonnegative, unknownUnreservedRequests: nonnegative, tokenReservations: nonnegative, tokenAllowanceStatus: z.string(), remainingEstimatedTokens: nonnegative.nullable(), estimatedTokenOverage: nonnegative.nullable() });
const usage = z.strictObject({ projectId: id, requests: nonnegative, knownInputTokens: nonnegative.nullable(), knownOutputTokens: nonnegative.nullable(), unknownUsageRequests: nonnegative.nullable(), captureBytes: nonnegative.nullable(), occupied: nonnegative.nullable(), backendDispatches: nonnegative.nullable(), tokenReservations: nonnegative.nullable(), allowance, recent: z.array(metadata).max(100), observedAt: nonnegative, period: z.string(), attemptVisibility: z.string(), accounting: z.string() });
const health = z.array(z.strictObject({ accountId: id, reference: z.string(), observedAt: z.string(), localCredentialReadable: z.boolean().optional(), backendAuthentication: z.string(), status: z.number().optional(), providerReachability: z.string(), providerQuota: z.string(), billableInferencePerformed: z.boolean(), credentialLifecycleOwner: z.string().optional(), exclusiveBinding: z.string().optional() }));
const principal = z.strictObject({ id: z.string(), project_id: id, workspace_id: z.string(), workspace_name: z.string(), route_id: id, enabled: z.number().int() });
const request = z.strictObject({ id: z.string().uuid(), project_id: id, principal_id: z.string(), account_id: id, started_at: nonnegative, finished_at: nonnegative.nullable(), model: z.string(), outcome: z.string(), execution: z.string(), delivery: z.string(), accounting: z.string(), occupied: nonnegative, cancel_requested: nonnegative, input_tokens: nonnegative.nullable(), output_tokens: nonnegative.nullable(), error_code: z.string().nullable() });
function operation<I, O>(name: string, description: string, access: OperationAccess, input: z.ZodType<I>, output: z.ZodType<O>): Operation<I, O> { return { name, description, access, parseInput: (value) => input.parse(value), parseOutput: (value) => output.parse(value) }; }
export const capabilitiesSchema = z.array(z.strictObject({ name: z.string(), description: z.string(), access: z.enum(["read", "operator", "reviewer"]) })).max(1000);
export const llmOperations: readonly Operation[] = [
  operation("capabilities", "Operations allowed for the authenticated operator actor", "read", empty, capabilitiesSchema),
  operation("overview", "Accounts, routes, models and service limits", "read", empty, overview),
  operation("health", "Probe configured backend authentication without inference", "read", empty, health),
  operation("projects", "List project routing policies and state", "read", empty, z.array(projectSchema)),
  operation("project.create", "Create a project with the selected route", "operator", z.strictObject({ projectId: id, routeId: id }), projectSchema),
  operation("project.policy", "Read a project's routing policy", "read", projectInput, projectSchema),
  operation("project.policy.update", "Replace a project's routing policy", "operator", projectInput.extend({ policy: policySchema, expectedRevision: z.string().regex(/^[a-f0-9]{64}$/) }), projectSchema),
  operation("project.state", "Pause, resume, enable or disable a project", "operator", projectInput.extend({ action: z.enum(["pause", "resume", "enable", "disable"]) }), projectSchema),
  operation("usage", "Project usage and admission reservations", "read", projectInput, usage),
  operation("principals", "List workspace credentials without credential hashes", "read", empty, z.array(principal)),
  operation("principal.revoke", "Revoke a workspace credential", "operator", z.strictObject({ principalId: z.string().min(1).max(128) }), z.strictObject({ revoked: z.literal(true) })),
  operation("requests", "List bounded request metadata without prompt or response content", "read", z.strictObject({ projectId: id.optional(), active: z.boolean().optional(), limit: positive.max(200).optional() }), z.array(request)),
  operation("request.cancel", "Request cancellation; upstream termination is unconfirmed", "operator", z.strictObject({ requestId: z.string().uuid() }), z.strictObject({ cancellationRequested: z.literal(true), upstreamTerminationConfirmed: z.literal(false) })),
  operation("request.resolve", "Resolve an indeterminate request with optional observed token usage", "operator", z.strictObject({ requestId: z.string().uuid(), usage: z.strictObject({ inputTokens: nonnegative, outputTokens: nonnegative }).optional() }), z.strictObject({ resolved: z.literal(true) }))
];
export function llmOperation(name: string): Operation { const operation = llmOperations.find((op) => op.name === name); if (!operation) throw new Error("unknown LLM router operation"); return operation; }
