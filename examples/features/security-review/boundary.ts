import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { lstat, realpath, mkdtemp, rm } from "node:fs/promises";

const execute = promisify(execFile);
export const boundaryImage = "docker@sha256:173f284a4299164772a90f52b373e73e087583c0963f1334c9995f190ef6f3f5";
const roles = ["agent-dind", "secure-dind"] as const;
type Role = typeof roles[number];
export interface BoundaryConfiguration {
  readonly schemaVersion: 1;
  readonly runtime: "sysbox-runc";
  readonly image: typeof boundaryImage;
  readonly services: Readonly<Record<Role, { readonly network: "none"; readonly secretAccess: boolean }>>;
}
function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("boundary configuration must contain objects");
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, expected: readonly string[]): void {
  if (Object.keys(value).sort().join(",") !== [...expected].sort().join(",")) throw new Error("unexpected boundary configuration fields");
}
/** This example intentionally supports one reviewed runtime/image/network. */
export function parseBoundaryConfiguration(value: unknown): BoundaryConfiguration {
  const input = record(value);
  keys(input, ["schemaVersion", "runtime", "image", "services"]);
  if (input.schemaVersion !== 1 || input.runtime !== "sysbox-runc" || input.image !== boundaryImage) throw new Error("unsupported boundary runtime, image or schema");
  const services = record(input.services);
  keys(services, roles);
  for (const role of roles) {
    const service = record(services[role]); keys(service, ["network", "secretAccess"]);
    if (service.network !== "none" || typeof service.secretAccess !== "boolean") throw new Error("invalid boundary service");
  }
  return input as unknown as BoundaryConfiguration;
}
export async function docker(args: readonly string[]): Promise<string> {
  return (await execute("docker", [...args], { timeout: 30_000, maxBuffer: 64 * 1024 })).stdout.trim();
}
/**
 * Trusted operator entry point. Pass configuration from an approved protected
 * commit, never a writable agent checkout. No host Docker socket is mounted.
 */
export async function startBoundary(configuration: BoundaryConfiguration, secretFile: string): Promise<{
  readonly containers: Readonly<Record<Role, string>>;
  close(): Promise<void>;
}> {
  parseBoundaryConfiguration(configuration);
  const secret = await lstat(secretFile);
  if (!secret.isFile() || secret.isSymbolicLink() || secret.uid !== process.getuid?.() || (secret.mode & 0o077) !== 0) throw new Error("operator secret must be a private regular file");
  const source = await realpath(secretFile);
  if (source.includes(",")) throw new Error("secret path cannot contain a comma");
  // Empty Docker config prevents host proxy credentials from reaching either role.
  const clientConfiguration = await mkdtemp(join(tmpdir(), "dim-review-boundary-docker-"));
  const run = (args: readonly string[]) => docker(["--config", clientConfiguration, ...args]);
  const created: string[] = [];
  const containers: Partial<Record<Role, string>> = {};
  const close = async () => {
    const results = await Promise.allSettled(created.map((id) => run(["rm", "--force", "--volumes", id])));
    const failure = results.find((result) => result.status === "rejected");
    await rm(clientConfiguration, { recursive: true, force: true });
    if (failure?.status === "rejected") throw failure.reason;
  };
  try {
    for (const role of roles) {
      const service = configuration.services[role];
      const id = await run(["create", "--pull=never", "--name", `dim-review-${role}-${randomUUID()}`, "--runtime", configuration.runtime,
        "--network", service.network, "--hostname", role, "--label", "dim.verification=security-review",
        ...(service.secretAccess ? ["--mount", `type=bind,source=${source},target=/run/secrets/service-token,readonly`] : []),
        "--entrypoint", "dockerd", configuration.image, "--host=unix:///var/run/docker.sock", "--storage-driver=vfs",
        "--iptables=false", "--bridge=none", "--ip-forward=false", "--ip-masq=false"]);
      if (!/^[a-f0-9]{64}$/.test(id)) throw new Error("invalid Docker container identity");
      created.push(id); containers[role] = id;
      await run(["start", id]);
    }
    for (const role of roles) {
      const id = containers[role];
      if (id === undefined) throw new Error("missing boundary container");
      await run(["exec", id, "sh", "-ec", "for attempt in $(seq 1 150); do docker info >/dev/null 2>&1 && exit 0; sleep 0.1; done; exit 1"]);
    }
    return { containers: containers as Record<Role, string>, close };
  } catch (error) { await close(); throw error; }
}
