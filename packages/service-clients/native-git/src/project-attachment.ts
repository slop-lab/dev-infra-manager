import {
  parseNativeGitProjectAttachment,
  parseNativeGitProjectCatalog,
  type NativeGitProjectAttachment,
  type NativeGitProjectCatalog
} from "@slop-lab/dim-contracts-git";
import {
  createNodeNativeGitAdmissionHttpClient,
  type NativeGitAdmissionHttpClient
} from "@slop-lab/dim-contracts-git/http";

export type NativeGitProjectAttachmentClientConfig = {
  readonly endpoint: string;
  readonly generationId: string;
  readonly ownerHostId: string;
  readonly credential: {
    readonly username: string;
    readonly password: string;
  };
};

export interface NativeGitProjectAttachmentClient {
  discover(signal: AbortSignal): Promise<NativeGitProjectCatalog>;
  inspect(projectId: string, signal: AbortSignal): Promise<NativeGitProjectAttachment>;
}

export class NativeGitProjectAttachmentClientError extends Error {
  readonly name: string = "NativeGitProjectAttachmentClientError";
}

export class NativeGitProjectAttachmentHttpError extends NativeGitProjectAttachmentClientError {
  override readonly name = "NativeGitProjectAttachmentHttpError";
  constructor(readonly statusCode: number) {
    super(`native Git Project attachment request failed with HTTP ${statusCode}`);
  }
}

export function createNativeGitProjectAttachmentClient(
  config: NativeGitProjectAttachmentClientConfig,
  httpClient: NativeGitAdmissionHttpClient = createNodeNativeGitAdmissionHttpClient()
): NativeGitProjectAttachmentClient {
  const authorization = `Basic ${Buffer.from(
    `${config.credential.username}:${config.credential.password}`,
    "utf8"
  ).toString("base64")}`;
  return {
    async discover(signal) {
      const catalog = parseNativeGitProjectCatalog(await request({
        httpClient, config, authorization, path: "/v1/projects", signal
      }));
      requireScope(config, catalog);
      return catalog;
    },
    async inspect(projectId, signal) {
      if (!/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(projectId)) invalid();
      const attachment = parseNativeGitProjectAttachment(await request({
        httpClient,
        config,
        authorization,
        path: `/v1/projects/${projectId}/attachment`,
        signal
      }));
      requireScope(config, attachment);
      if (attachment.projectId !== projectId) invalid();
      return attachment;
    }
  };
}

type ProjectAttachmentRequest = {
  readonly httpClient: NativeGitAdmissionHttpClient;
  readonly config: NativeGitProjectAttachmentClientConfig;
  readonly authorization: string;
  readonly path: string;
  readonly signal: AbortSignal;
};

async function request(input: ProjectAttachmentRequest): Promise<unknown> {
  let response;
  try {
    response = await input.httpClient.request({
      endpoint: input.config.endpoint,
      method: "GET",
      path: input.path,
      authorization: input.authorization,
      generationId: input.config.generationId,
      signal: AbortSignal.any([input.signal, AbortSignal.timeout(10_000)])
    });
  } catch (cause) {
    throw new NativeGitProjectAttachmentClientError("native Git Project attachment request failed", { cause });
  }
  if (response.statusCode !== 200) throw new NativeGitProjectAttachmentHttpError(response.statusCode);
  if (response.contentType !== "application/json" || response.cacheControl !== "no-store") invalid();
  try {
    const value: unknown = JSON.parse(response.body.toString("utf8"));
    return value;
  } catch (cause) {
    if (cause instanceof SyntaxError) {
      throw new NativeGitProjectAttachmentClientError("native Git Project attachment response is not valid JSON", { cause });
    }
    throw cause;
  }
}

function requireScope(
  config: NativeGitProjectAttachmentClientConfig,
  result: Pick<NativeGitProjectCatalog, "generationId" | "ownerHostId">
): void {
  if (result.generationId !== config.generationId || result.ownerHostId !== config.ownerHostId) invalid();
}

function invalid(): never {
  throw new NativeGitProjectAttachmentClientError("native Git Project attachment response conflicts with its request");
}
