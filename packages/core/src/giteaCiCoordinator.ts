import { UserError } from "./errors.js";
import { configureGiteaWebhookAllowedHosts, ensureGitea, giteaRequest, giteaRunnerBaseUrl } from "./gitea.js";
import { LifecycleState } from "./lifecycleState.js";
import type { CiCoordinator, CiRunnerRegistration, QueuedWorkflowJob } from "./ciCoordinator.js";
import type { ProjectRecord } from "./lifecycleTypes.js";

export function giteaCiRunnerApiBase(project: Pick<ProjectRecord, "gitNamespace">): string {
  return `/orgs/${encodeURIComponent(project.gitNamespace)}/actions/runners`;
}

function giteaOrgHooksApiBase(project: Pick<ProjectRecord, "gitNamespace">): string {
  return `/orgs/${encodeURIComponent(project.gitNamespace)}/hooks`;
}

const QUEUED_JOBS_PAGE_SIZE = 100;
const MAX_QUEUED_JOB_PAGES = 100;

type QueuedJobsEndpoint = {
  readonly credentials: Awaited<ReturnType<typeof ensureGitea>>;
  readonly apiPath: string;
};

interface GiteaHookSummary {
  id: number;
  config?: { url?: string };
}

export function giteaHookIdsForUrl(hooks: GiteaHookSummary[], url: string): number[] {
  return hooks.filter((hook) => hook.config?.url === url).map((hook) => hook.id);
}

async function removeHooksForUrl(credentials: Awaited<ReturnType<typeof ensureGitea>>, project: ProjectRecord, url: string): Promise<void> {
  const base = giteaOrgHooksApiBase(project);
  const response = await giteaRequest(credentials, "GET", base);
  if (!response.ok) throw new UserError(`failed to list CI coordinator webhooks: ${response.status}`);
  const hooks = await response.json() as GiteaHookSummary[];
  for (const id of giteaHookIdsForUrl(hooks, url)) {
    const removed = await giteaRequest(credentials, "DELETE", `${base}/${id}`);
    if (!removed.ok && removed.status !== 404) throw new UserError(`failed to remove CI coordinator webhook target '${url}': ${removed.status}`);
  }
}

export const giteaCiCoordinator: CiCoordinator = {
  async prepareRunner(runner, options, project): Promise<CiRunnerRegistration> {
    const credentials = await ensureGitea(runner, options);
    const base = giteaCiRunnerApiBase(project);
    const response = await giteaRequest(
      credentials,
      "POST",
      `${base}/registration-token`
    );
    if (!response.ok) throw new UserError(`failed to prepare CI runner registration: ${response.status}`);
    const body = await response.json() as { token?: string };
    if (!body.token) throw new UserError("CI coordinator returned an empty runner registration token");
    return {
      provider: "gitea-actions",
      instanceUrl: await giteaRunnerBaseUrl(runner, credentials),
      token: body.token
    };
  },
  async removeRunner(runner, options, project, runnerName): Promise<void> {
    const credentials = await ensureGitea(runner, options);
    const base = giteaCiRunnerApiBase(project);
    const response = await giteaRequest(credentials, "GET", base);
    if (!response.ok) throw new UserError(`failed to list CI coordinator runners: ${response.status}`);
    const body = await response.json() as { runners?: Array<{ id: number; name: string }> };
    for (const candidate of body.runners ?? []) {
      if (candidate.name !== runnerName) continue;
      const removed = await giteaRequest(credentials, "DELETE", `${base}/${candidate.id}`);
      if (!removed.ok && removed.status !== 404) {
        throw new UserError(`failed to remove CI coordinator runner '${runnerName}': ${removed.status}`);
      }
    }
  },
  async ensureWorkflowJobWebhook(runner, options, project, input): Promise<void> {
    if (input.central !== true) await this.reconcileWorkflowJobWebhookTargets(runner, options);
    const credentials = await ensureGitea(runner, options);
    if (input.central === true) {
      await ensureSingleHook(credentials, project, input.url, input.authorizationHeader);
    } else {
      await removeHooksForUrl(credentials, project, input.url);
      await createHook(credentials, project, input.url, input.authorizationHeader);
    }
    await replayQueuedJobs(credentials, project, input.replayQueuedJob);
  },
  async removeWorkflowJobWebhook(runner, options, project, url): Promise<void> {
    await removeHooksForUrl(await ensureGitea(runner, options), project, url);
  },
  async reconcileWorkflowJobWebhookTargets(runner, options, excluding): Promise<void> {
    const records = await new LifecycleState(options.stateRoot).listCiRunners();
    const allowedHosts = records.flatMap((record) =>
      record.executor.kind === "qemu" && record.executor.phase !== "stopped"
        && (excluding === undefined || record.projectName !== excluding.project || record.name !== excluding.name)
        ? [record.executor.supervisorName]
        : []);
    await configureGiteaWebhookAllowedHosts(runner, options, allowedHosts);
  }
};

async function createHook(
  credentials: Awaited<ReturnType<typeof ensureGitea>>,
  project: ProjectRecord,
  url: string,
  authorizationHeader: string
): Promise<void> {
  const response = await giteaRequest(credentials, "POST", giteaOrgHooksApiBase(project), {
    type: "gitea",
    active: true,
    events: ["workflow_job"],
    authorization_header: authorizationHeader,
    config: { url, content_type: "json" }
  });
  if (!response.ok) throw new UserError(`failed to create CI coordinator webhook: ${response.status}`);
}

async function ensureSingleHook(
  credentials: Awaited<ReturnType<typeof ensureGitea>>,
  project: ProjectRecord,
  url: string,
  authorizationHeader: string
): Promise<void> {
  const base = giteaOrgHooksApiBase(project);
  const initial = await giteaRequest(credentials, "GET", base);
  if (!initial.ok) throw new UserError(`failed to list CI coordinator webhooks: ${initial.status}`);
  const initialHooks = await initial.json() as GiteaHookSummary[];
  if (giteaHookIdsForUrl(initialHooks, url).length === 0) await createHook(credentials, project, url, authorizationHeader);
  const final = await giteaRequest(credentials, "GET", base);
  if (!final.ok) throw new UserError(`failed to list CI coordinator webhooks: ${final.status}`);
  const ids = giteaHookIdsForUrl(await final.json() as GiteaHookSummary[], url).sort((left, right) => left - right);
  if (ids.length === 0) throw new UserError("failed to create central CI coordinator webhook");
  for (const id of ids.slice(1)) {
    const removed = await giteaRequest(credentials, "DELETE", `${base}/${id}`);
    if (!removed.ok && removed.status !== 404) throw new UserError(`failed to deduplicate central CI coordinator webhook: ${removed.status}`);
  }
}

async function replayQueuedJobs(
  credentials: Awaited<ReturnType<typeof ensureGitea>>,
  project: ProjectRecord,
  replayQueuedJob: (job: QueuedWorkflowJob) => Promise<void>
): Promise<void> {
  const apiPath = `/orgs/${encodeURIComponent(project.gitNamespace)}/actions/jobs`;
  const endpoint = { credentials, apiPath } satisfies QueuedJobsEndpoint;
  const firstResponse = await listQueuedJobsPage(endpoint, 1, QUEUED_JOBS_PAGE_SIZE);
  const firstPage = parseQueuedJobsResponse(await parseJsonResponse(firstResponse));
  const pagination = parseQueuedJobsPagination(firstResponse, firstPage, endpoint);
  if (pagination.lastPage > MAX_QUEUED_JOB_PAGES) {
    throw new UserError(`failed to list queued workflow jobs: pagination exceeded ${MAX_QUEUED_JOB_PAGES} pages`);
  }

  const jobs = new Map(firstPage.jobs.map((job) => [job.id, job]));
  let requiredJobs = firstPage.totalCount;
  for (let page = pagination.lastPage; page >= 1 && pagination.lastPage > 1; page -= 1) {
    const response = await listQueuedJobsPage(endpoint, page, pagination.pageSize);
    const body = parseQueuedJobsResponse(await parseJsonResponse(response));
    if (body.jobs.length > pagination.pageSize) {
      throw new UserError("failed to list queued workflow jobs: inconsistent queued workflow job pagination");
    }
    requiredJobs = Math.max(requiredJobs, body.totalCount);
    for (const job of body.jobs) jobs.set(job.id, job);
  }
  if (jobs.size < requiredJobs) {
    throw new UserError("failed to list queued workflow jobs: inconsistent queued workflow job pagination");
  }
  for (const job of [...jobs.values()].sort((left, right) => left.id - right.id)) await replayQueuedJob(job);
}

async function listQueuedJobsPage(
  endpoint: QueuedJobsEndpoint,
  page: number,
  pageSize: number
): Promise<Response> {
  const response = await giteaRequest(endpoint.credentials, "GET", `${endpoint.apiPath}?status=queued&page=${page}&limit=${pageSize}`);
  if (!response.ok) throw new UserError(`failed to list queued workflow jobs: ${response.status}`);
  return response;
}

function parseQueuedJobsPagination(
  response: Response,
  body: { readonly totalCount: number; readonly jobs: readonly QueuedWorkflowJob[] },
  endpoint: QueuedJobsEndpoint
): { readonly lastPage: number; readonly pageSize: number } {
  if (body.totalCount <= body.jobs.length) return { lastPage: 1, pageSize: QUEUED_JOBS_PAGE_SIZE };
  if (body.jobs.length === 0) {
    throw new UserError("failed to list queued workflow jobs: inconsistent queued workflow job pagination");
  }
  const linkHeader = response.headers.get("link");
  if (linkHeader !== null) {
    const lastLink = linkHeader.split(",").find((entry) => /;\s*rel="last"\s*$/.test(entry));
    if (lastLink === undefined) throw new UserError("failed to list queued workflow jobs: invalid pagination metadata");
    return parseLastPageLink(lastLink, body, endpoint);
  }
  return { lastPage: Math.ceil(body.totalCount / body.jobs.length), pageSize: body.jobs.length };
}

function parseLastPageLink(
  link: string,
  body: { readonly totalCount: number; readonly jobs: readonly QueuedWorkflowJob[] },
  endpoint: QueuedJobsEndpoint
): { readonly lastPage: number; readonly pageSize: number } {
  const match = /^\s*<([^>]+)>;\s*rel="last"\s*$/.exec(link);
  const rawUrl = match?.[1];
  if (rawUrl === undefined) throw new UserError("failed to list queued workflow jobs: invalid pagination metadata");
  let baseUrl: URL;
  let lastUrl: URL;
  try {
    baseUrl = new URL(endpoint.credentials.apiBaseUrl);
    lastUrl = new URL(rawUrl);
  } catch (error) {
    if (error instanceof TypeError) throw new UserError("failed to list queued workflow jobs: invalid pagination metadata");
    throw error;
  }
  const page = parsePositiveInteger(lastUrl.searchParams.get("page"));
  const requestedPageSize = parsePositiveInteger(lastUrl.searchParams.get("limit"));
  const queryKeys = [...lastUrl.searchParams.keys()].sort().join(",");
  if (lastUrl.username !== ""
    || lastUrl.password !== ""
    || lastUrl.hash !== ""
    || lastUrl.pathname !== `${baseUrl.pathname}${endpoint.apiPath}`
    || lastUrl.searchParams.get("status") !== "queued"
    || queryKeys !== "limit,page,status"
    || page === undefined
    || requestedPageSize !== QUEUED_JOBS_PAGE_SIZE
    || page !== Math.ceil(body.totalCount / body.jobs.length)) {
    throw new UserError("failed to list queued workflow jobs: invalid pagination metadata");
  }
  return { lastPage: page, pageSize: body.jobs.length };
}

function parsePositiveInteger(value: string | null): number | undefined {
  if (value === null || !/^[1-9]\d*$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

async function parseJsonResponse(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch (error) {
    if (error instanceof SyntaxError) throw new UserError("failed to list queued workflow jobs: invalid JSON response");
    throw error;
  }
}

function parseQueuedJobsResponse(value: unknown): { readonly totalCount: number; readonly jobs: readonly QueuedWorkflowJob[] } {
  if (!isRecord(value) || !Number.isSafeInteger(value.total_count) || Number(value.total_count) < 0 || !Array.isArray(value.jobs)) {
    throw new UserError("failed to list queued workflow jobs: invalid response body");
  }
  const jobs = value.jobs.map(parseQueuedJob);
  const totalCount = Number(value.total_count);
  if (totalCount < jobs.length) throw new UserError("failed to list queued workflow jobs: invalid response body");
  for (let index = 1; index < jobs.length; index += 1) {
    const previous = jobs[index - 1];
    const current = jobs[index];
    if (previous === undefined || current === undefined || previous.id >= current.id) {
      throw new UserError("failed to list queued workflow jobs: invalid response body");
    }
  }
  return { totalCount, jobs };
}

function parseQueuedJob(value: unknown): QueuedWorkflowJob {
  if (!isRecord(value)
    || !Number.isSafeInteger(value.id)
    || Number(value.id) <= 0
    || value.status !== "queued"
    || !Array.isArray(value.labels)
    || !value.labels.every((label) => typeof label === "string")) {
    throw new UserError("failed to list queued workflow jobs: invalid response body");
  }
  return { id: Number(value.id), labels: value.labels };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
