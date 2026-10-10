import type { IncomingMessage, ServerResponse } from "node:http";
import { AdmissionVerifierTimeoutError } from "./admission-verifier.js";
import type { NativeGitBundleConfig } from "./bundle-config.js";
import { bindExactActivation } from "./native-bundle-activation.js";
import {
  bearerAuthorized,
  isNativeGitBusinessRequest,
  parseActivationGeneration,
  readBoundedJson,
  sendJson,
  sendNotFound
} from "./native-bundle-http.js";
import type { NativeGitBundleState } from "./native-bundle-state.js";
import type { NativeGitBundleServerOptions, NativeGitPreparedProject } from "./native-bundle-server-types.js";
import {
  handleNativeGitProjectRegistrarHttp,
  type NativeGitProjectRegistrar
} from "./native-project-registrar-http.js";
import type { NativeProjectRootImportService } from "./native-project-root-import-http.js";
import type { NativeProjectRootReadService } from "./native-project-root-read-http.js";
import type { NativeProjectWorkspaceWriteService } from "./native-project-workspace-write-http.js";
import {
  attestNativeRootAdmissionReader,
  OrdinaryAdmissionVerifierError,
  type AdmissionVerifierHttpClient
} from "./ordinary-admission-http.js";
import { nativeGitRoute } from "./routing.js";
import type { NativeHumanReviewerService } from "./native-human-reviewer-http.js";
import type { NativeRootCiProofService } from "./native-root-ci-proof-http.js";

type RequestHandlerInput = {
  readonly activationTokenDigest: string;
  readonly config: NativeGitBundleConfig;
  readonly identityHttpClient: AdmissionVerifierHttpClient;
  readonly options: Pick<NativeGitBundleServerOptions,
    "activationToken" | "expectedGenerationId" | "readinessToken">;
  readonly registrars: readonly NativeGitProjectRegistrar[];
  readonly rootImportService: NativeProjectRootImportService;
  readonly rootReadService: NativeProjectRootReadService;
  readonly state: NativeGitBundleState;
  readonly workspaceWriteService: NativeProjectWorkspaceWriteService;
  readonly humanReviewerService: NativeHumanReviewerService;
  readonly rootCiProofService: NativeRootCiProofService;
  readonly deliveryHealthy: () => boolean;
  readonly activated: () => boolean;
  readonly activate: () => void;
  readonly prepareProject: (
    generationId: string,
    ownerHostId: string,
    input: unknown
  ) => Promise<NativeGitPreparedProject>;
};

export function createNativeBundleRequestHandler(input: RequestHandlerInput) {
  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const url = new URL(request.url ?? "/", "http://dim-native-git");
    if (request.method === "GET" && url.pathname === "/readyz" && url.search === "") {
      if (!bearerAuthorized(request, input.options.readinessToken)) return sendNotFound(response);
      if (!input.deliveryHealthy()) return sendJson(response, 503, { error: "native event delivery is unavailable" });
      try {
        await attestNativeRootAdmissionReader({
          config: input.config.ordinaryCi,
          httpClient: input.identityHttpClient,
          timeoutMilliseconds: 2_000
        }, input.options.expectedGenerationId);
      } catch (error) {
        if (error instanceof OrdinaryAdmissionVerifierError || error instanceof AdmissionVerifierTimeoutError) {
          return sendJson(response, 503, { error: "ordinary CI identity is unavailable" });
        }
        throw error;
      }
      return sendJson(response, 200, { status: "ready", schemaVersion: 1 });
    }
    if (request.method === "POST" && url.pathname === "/v1/activation" && url.search === "") {
      if (request.socket.remoteAddress !== "127.0.0.1") return sendNotFound(response);
      if (!bearerAuthorized(request, input.options.activationToken)) return sendNotFound(response);
      const generationId = parseActivationGeneration(await readBoundedJson(request));
      if (generationId !== input.options.expectedGenerationId) {
        return sendJson(response, 409, { error: "activation generation conflicts with service startup" });
      }
      if (!bindExactActivation(input.state, generationId, input.activationTokenDigest)) {
        return sendJson(response, 409, { error: "native Git activation binding conflicts with durable state" });
      }
      input.activate();
      return sendJson(response, 200, { schemaVersion: 1, generationId, activated: true });
    }
    if (await input.rootReadService.handleLeaseRequest(request, response, url)) return;
    if (await input.workspaceWriteService.handleLeaseRequest(request, response, url)) return;
    if (await input.humanReviewerService.handle(request, response, url)) return;
    if (await input.rootCiProofService.handle(request, response, url)) return;
    if (/^\/v1\/projects\/[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?\/root-import\/proof$/.test(url.pathname)
      && (request.method !== "GET" || url.search !== "")) return sendNotFound(response);
    if (url.search === "" && (url.pathname === "/v1/operator-root-importer-identity"
      || /^\/v1\/projects\/.+\/root-import(?:\/(?:finalize|proof))?$/.test(url.pathname))) {
      if (await input.rootImportService.handle(request, response, url.pathname)) return;
    }
    if (url.search === "" && await handleNativeGitProjectRegistrarHttp({
      request,
      response,
      pathname: url.pathname,
      activated: input.activated(),
      expectedGenerationId: input.options.expectedGenerationId,
      registrars: input.registrars,
      knownCredentials: [
        ...input.config.projectRootImporters,
        ...input.config.projectRootReadIssuers,
        ...input.config.workspaceWriteIssuers,
        ...input.config.humanReviewers,
        input.config.ordinaryCi.query,
        input.config.ordinaryCi.identity,
        input.config.ordinaryCi.attemptIssuer,
        input.config.ordinaryCi.resultReporter,
        input.config.ordinaryCi.webhook
      ],
      prepareProject: input.prepareProject
    })) return;
    if (!input.activated() && isNativeGitBusinessRequest(request.method, url.pathname)) {
      return sendJson(response, 503, { error: "native Git business operations require exact generation activation" });
    }
    const route = nativeGitRoute(request);
    if (route === undefined) return sendNotFound(response);
    if (await input.workspaceWriteService.serveGit(request, response, route)) return;
    return input.rootReadService.serveGit(request, response, route);
  };
}
