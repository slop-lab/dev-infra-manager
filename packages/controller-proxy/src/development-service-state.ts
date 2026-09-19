import { randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export const DEVELOPMENT_SERVICE_GATEWAY_PORT = 31_887;

export type DevelopmentServiceRoute = {
  readonly name: string;
  readonly urlId: string;
  readonly url: string;
  readonly authority: string;
  readonly ingress: string;
  readonly targetPort: number;
};

export function developmentServiceStateDirectory(home = process.env.HOME): string {
  if (!home || !path.isAbsolute(home)) throw new DevelopmentServiceStateError("HOME must be an absolute path");
  return path.join(path.resolve(home), ".local", "state", "dim", "development-service");
}

export function developmentServiceControlSocket(stateDirectory: string): string {
  return path.join(stateDirectory, "gateway.sock");
}

export async function prepareStateDirectory(stateDirectory: string): Promise<void> {
  if (!path.isAbsolute(stateDirectory) || path.resolve(stateDirectory) !== stateDirectory) {
    throw new DevelopmentServiceStateError("development service state directory must be an absolute canonical path");
  }
  const parsed = path.parse(stateDirectory);
  let current = parsed.root;
  for (const segment of stateDirectory.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    let metadata: Stats;
    try {
      metadata = await lstat(current);
    } catch (error) {
      if (!isErrorCode(error, "ENOENT")) throw error;
      try {
        await mkdir(current, { mode: 0o700 });
      } catch (mkdirError) {
        if (!isErrorCode(mkdirError, "EEXIST")) throw mkdirError;
      }
      metadata = await lstat(current);
    }
    if (metadata.isSymbolicLink()) {
      throw new DevelopmentServiceStateError(`development service state path contains a symbolic link: ${current}`);
    }
    if (!metadata.isDirectory()) {
      throw new DevelopmentServiceStateError(`development service state path is not a directory: ${current}`);
    }
  }
  await chmod(stateDirectory, 0o700);
}

export async function loadRoutes(stateDirectory: string): Promise<readonly DevelopmentServiceRoute[]> {
  const target = path.join(stateDirectory, "services.json");
  try {
    await requireRegularFile(target);
    const value: unknown = JSON.parse(await readFile(target, "utf8"));
    if (!Array.isArray(value) || !value.every(isDevelopmentServiceRoute)) {
      throw new DevelopmentServiceStateError("development service state is invalid");
    }
    return value;
  } catch (error) {
    if (isErrorCode(error, "ENOENT")) return [];
    if (error instanceof SyntaxError) throw new DevelopmentServiceStateError("development service state is invalid", error);
    throw error;
  }
}

export async function saveRoutes(
  stateDirectory: string,
  routes: readonly DevelopmentServiceRoute[]
): Promise<void> {
  const target = path.join(stateDirectory, "services.json");
  await requireRegularFileIfPresent(target);
  const temporary = path.join(stateDirectory, `services.${process.pid}.${randomUUID()}.tmp`);
  await writeFile(temporary, `${JSON.stringify(routes, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  try {
    await rename(temporary, target);
    await chmod(target, 0o600);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

export function parseAuthority(value: string): string {
  if (value.includes(",") || value.includes("/") || value.includes("@") || /\s/.test(value)) {
    throw new DevelopmentServiceStateError("invalid service URL authority");
  }
  let parsed: URL;
  try {
    parsed = new URL(`http://${value}`);
  } catch (error) {
    throw new DevelopmentServiceStateError("invalid service URL authority", error);
  }
  if (!parsed.hostname || parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new DevelopmentServiceStateError("invalid service URL authority");
  }
  return parsed.host.toLowerCase();
}

export function isDevelopmentServiceRoute(value: unknown): value is DevelopmentServiceRoute {
  if (!isObject(value)) return false;
  return typeof value.name === "string"
    && /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(value.name)
    && typeof value.urlId === "string"
    && value.urlId.length > 0
    && typeof value.url === "string"
    && typeof value.authority === "string"
    && typeof value.ingress === "string"
    && isPort(value.targetPort)
    && routeUrlMatches(value.url, value.authority);
}

export function isPort(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 65_535;
}

export class DevelopmentServiceStateError extends Error {
  readonly name = "DevelopmentServiceStateError";

  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function routeUrlMatches(url: string, authority: string): boolean {
  try {
    const parsed = new URL(url);
    return (parsed.protocol === "http:" || parsed.protocol === "https:")
      && !parsed.username
      && !parsed.password
      && parsed.pathname === "/"
      && !parsed.search
      && !parsed.hash
      && parsed.origin === url
      && parseAuthority(parsed.host) === authority;
  } catch {
    return false;
  }
}

function isErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

async function requireRegularFile(target: string): Promise<void> {
  const metadata = await lstat(target);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new DevelopmentServiceStateError(`development service state is not a regular file: ${target}`);
  }
}

async function requireRegularFileIfPresent(target: string): Promise<void> {
  try {
    await requireRegularFile(target);
  } catch (error) {
    if (!isErrorCode(error, "ENOENT")) throw error;
  }
}
